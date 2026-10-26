import { describe, expect, it } from "vitest";

import {
  PCM16_16K_MONO,
  createMediaEvent,
  providerError,
  type InputAudioChunk,
  type ProviderCapabilities,
  type SessionId,
  type SpeechToTextProvider,
  type SttOpenRequest,
  type SttStream,
  type TranscriptEvent,
} from "@tvic/core";
import { AsyncQueue } from "@tvic/media";

import { getSttRecoveryControl, withSttReconnect } from "../src/resilient-stt.js";
import { SerialSttCommandController } from "../src/stt-command-controller.js";
import { boundSttAgentContext } from "../src/stt-agent-context.js";
import { TS } from "./harness.js";

interface ContextCommandController extends SerialSttCommandController {
  admitAgentContext(context: string): Promise<void>;
}

describe("STT agent context commands", () => {
  it("admits caller audio while preserving dispatch order after context enqueue", async () => {
    const order: string[] = [];
    let markContextStarted!: () => void;
    const contextStarted = new Promise<void>((resolve) => {
      markContextStarted = resolve;
    });
    let releaseContext!: () => void;
    const contextGate = new Promise<void>((resolve) => {
      releaseContext = resolve;
    });
    const stream: SttStream & {
      updateAgentContext(
        context: string,
        options?: { readonly signal?: AbortSignal },
      ): Promise<void>;
    } = {
      events: new AsyncQueue<TranscriptEvent>(),
      async sendAudio(chunk) {
        order.push(`audio:${chunk.audio.bytes[0] ?? 0}`);
      },
      async updateAgentContext() {
        order.push("context:start");
        markContextStarted();
        await contextGate;
        order.push("context:done");
      },
      async commit() {},
      async close() {},
    };
    const controller = new SerialSttCommandController({ stream }) as ContextCommandController;

    const contextUpdate = controller.admitAgentContext("assistant reply");
    await contextStarted;
    await controller.admitAudio(audioChunk(1));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const audioPassedContext = order.includes("audio:1");
    releaseContext();
    await contextUpdate;
    await controller.drain();

    expect(audioPassedContext).toBe(false);
    expect(order).toEqual(["context:start", "context:done", "audio:1"]);
  });

  it("sends a replacement context before admitted caller audio", async () => {
    const order: string[] = [];
    let markFirstContextStarted!: () => void;
    const firstContextStarted = new Promise<void>((resolve) => {
      markFirstContextStarted = resolve;
    });
    let releaseFirstContext!: () => void;
    const firstContextGate = new Promise<void>((resolve) => {
      releaseFirstContext = resolve;
    });
    const stream: SttStream & { updateAgentContext(context: string): Promise<void> } = {
      events: new AsyncQueue<TranscriptEvent>(),
      async sendAudio(chunk) {
        order.push(`audio:${chunk.audio.bytes[0] ?? 0}`);
      },
      async updateAgentContext(context) {
        order.push(`context:${context}`);
        if (context === "full response") {
          markFirstContextStarted();
          await firstContextGate;
          order.push("context:full response accepted");
        }
      },
      async commit() {},
      async close() {},
    };
    const controller = new SerialSttCommandController({ stream }) as ContextCommandController;

    const fullContext = controller.admitAgentContext("full response");
    await firstContextStarted;
    const alignedPrefix = controller.admitAgentContext("heard prefix");
    const alignedPrefixOutcome = alignedPrefix.then(
      () => undefined,
      (error: unknown) => error,
    );
    await controller.admitAudio(audioChunk(5));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const audioPassedPendingContext = order.includes("audio:5");
    releaseFirstContext();
    const [, alignedPrefixError] = await Promise.all([fullContext, alignedPrefixOutcome]);
    await waitFor(() => order.includes("audio:5"));
    await controller.drain();

    expect(audioPassedPendingContext).toBe(false);
    expect(alignedPrefixError).toBeUndefined();
    expect(order).toEqual([
      "context:full response",
      "context:full response accepted",
      "context:heard prefix",
      "audio:5",
    ]);
  });

  it("reports an unconfirmed context enqueue as recoverable and continues audio dispatch", async () => {
    const audioValues: number[] = [];
    let markContextStarted!: () => void;
    const contextStarted = new Promise<void>((resolve) => {
      markContextStarted = resolve;
    });
    let failed = false;
    let updateSignal: AbortSignal | undefined;
    const stream: SttStream & {
      updateAgentContext(
        context: string,
        options?: { readonly signal?: AbortSignal },
      ): Promise<void>;
    } = {
      events: new AsyncQueue<TranscriptEvent>(),
      async sendAudio(chunk) {
        audioValues.push(chunk.audio.bytes[0] ?? 0);
      },
      async updateAgentContext(_context, options) {
        markContextStarted();
        updateSignal = options?.signal;
        await new Promise<void>(() => undefined);
      },
      async commit() {},
      async close() {},
    };
    const controller = new SerialSttCommandController({
      stream,
      contextUpdateTimeoutMs: 10,
    }) as ContextCommandController;
    void controller.failure.catch(() => {
      failed = true;
    });

    const contextUpdate = controller.admitAgentContext("assistant reply");
    await contextStarted;
    await controller.admitAudio(audioChunk(2));

    await expect(contextUpdate).rejects.toMatchObject({
      code: "stt.context_update_failed",
      category: "timeout",
      retriable: true,
    });
    await waitFor(() => audioValues.length === 1);
    await controller.drain();

    expect(failed).toBe(false);
    expect(audioValues).toEqual([2]);
    expect(updateSignal?.aborted).toBe(true);
  });

  it("cancels a timed-out context write before it can land after later audio", async () => {
    const order: string[] = [];
    let markContextStarted!: () => void;
    const contextStarted = new Promise<void>((resolve) => {
      markContextStarted = resolve;
    });
    let releaseContext!: () => void;
    const delayedContext = new Promise<void>((resolve) => {
      releaseContext = resolve;
    });
    const stream: SttStream = {
      events: new AsyncQueue<TranscriptEvent>(),
      async sendAudio(chunk) {
        order.push(`audio:${chunk.audio.bytes[0] ?? 0}`);
      },
      async updateAgentContext(context, options) {
        markContextStarted();
        await delayedContext;
        if (options?.signal?.aborted) return;
        order.push(`context:${context}`);
      },
      async commit() {},
      async close() {},
    };
    const controller = new SerialSttCommandController({
      stream,
      contextUpdateTimeoutMs: 10,
    }) as ContextCommandController;
    const contextUpdate = controller.admitAgentContext("stale reply");
    await contextStarted;
    await controller.admitAudio(audioChunk(5));

    await expect(contextUpdate).rejects.toMatchObject({
      code: "stt.context_update_failed",
      category: "timeout",
      retriable: true,
    });
    await waitFor(() => order.includes("audio:5"));
    releaseContext();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await controller.drain();

    expect(order).toEqual(["audio:5"]);
  });

  it("rejects active and queued context updates when the controller aborts", async () => {
    let markContextStarted!: () => void;
    const contextStarted = new Promise<void>((resolve) => {
      markContextStarted = resolve;
    });
    const stream: SttStream & { updateAgentContext(context: string): Promise<void> } = {
      events: new AsyncQueue<TranscriptEvent>(),
      async sendAudio() {},
      async updateAgentContext() {
        markContextStarted();
        await new Promise<void>(() => undefined);
      },
      async commit() {},
      async close() {},
    };
    const controller = new SerialSttCommandController({ stream }) as ContextCommandController;
    const activeUpdate = controller.admitAgentContext("active reply");
    await contextStarted;
    const queuedUpdate = controller.admitAgentContext("queued reply");
    const activeOutcome = activeUpdate.then(
      () => ({ kind: "resolved" as const }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );
    const queuedOutcome = queuedUpdate.then(
      () => ({ kind: "resolved" as const }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );

    await controller.abort();

    expect(await activeOutcome).toMatchObject({
      kind: "rejected",
      error: { code: "stt.reconnect.closed" },
    });
    expect(await queuedOutcome).toMatchObject({
      kind: "rejected",
      error: { code: "stt.reconnect.closed" },
    });
  });

  it("continues audio dispatch after a context write is rejected", async () => {
    const audioValues: number[] = [];
    let failed = false;
    const stream: SttStream & { updateAgentContext(context: string): Promise<void> } = {
      events: new AsyncQueue<TranscriptEvent>(),
      async sendAudio(chunk) {
        audioValues.push(chunk.audio.bytes[0] ?? 0);
      },
      async updateAgentContext() {
        throw new Error("context must not be logged");
      },
      async commit() {},
      async close() {},
    };
    const controller = new SerialSttCommandController({ stream }) as ContextCommandController;
    controller.failure.catch(() => {
      failed = true;
    });

    await expect(controller.admitAgentContext("private assistant reply")).rejects.toMatchObject({
      code: "stt.context_update_failed",
      retriable: true,
    });
    await controller.admitAudio(audioChunk(7));
    await waitFor(() => audioValues.length === 1);
    await controller.drain();

    expect(failed).toBe(false);
    expect(audioValues).toEqual([7]);
  });

  it("keeps the newest 1500 Unicode code points without splitting a surrogate pair", () => {
    const context = `${"a".repeat(1_499)}🙂older`;

    expect(boundSttAgentContext(context)).toBe(`${"a".repeat(1_494)}🙂older`);
    expect([...boundSttAgentContext(context)]).toHaveLength(1_500);
  });

  it("coalesces pending updates in FIFO order without blocking audio admission", async () => {
    const order: string[] = [];
    let releaseFirstAudio: (() => void) | undefined;
    let firstAudioStarted = false;
    const stream: SttStream & { updateAgentContext(context: string): Promise<void> } = {
      events: new AsyncQueue<TranscriptEvent>(),
      async sendAudio(chunk) {
        const value = chunk.audio.bytes[0] ?? 0;
        if (value === 1) {
          firstAudioStarted = true;
          await new Promise<void>((resolve) => {
            releaseFirstAudio = resolve;
          });
        }
        order.push(`audio:${value}`);
      },
      async updateAgentContext(context) {
        order.push(`context:${context}`);
      },
      async commit() {},
      async close() {},
    };
    const controller = new SerialSttCommandController({ stream }) as ContextCommandController;

    await controller.admitAudio(audioChunk(1));
    await waitFor(() => firstAudioStarted);
    const firstUpdate = controller.admitAgentContext("first reply");
    await controller.admitAudio(audioChunk(2));
    const latestUpdate = controller.admitAgentContext("latest reply");

    expect(firstUpdate).toBe(latestUpdate);
    expect(order).toEqual([]);
    releaseFirstAudio?.();
    await Promise.all([firstUpdate, latestUpdate]);
    await controller.drain();

    expect(order).toEqual(["audio:1", "context:latest reply", "audio:2"]);
  });

  it("holds replayed caller audio until reconnect context enqueue is confirmed", async () => {
    const generations: Array<{
      readonly order: string[];
      readonly events: AsyncQueue<TranscriptEvent>;
    }> = [];
    let openCount = 0;
    let markSecondOpenStarted!: () => void;
    const secondOpenStarted = new Promise<void>((resolve) => {
      markSecondOpenStarted = resolve;
    });
    let releaseSecondOpen!: () => void;
    const secondOpenGate = new Promise<void>((resolve) => {
      releaseSecondOpen = resolve;
    });
    let markReconnectContextStarted!: () => void;
    const reconnectContextStarted = new Promise<void>((resolve) => {
      markReconnectContextStarted = resolve;
    });
    let releaseReconnectContext!: () => void;
    const reconnectContextGate = new Promise<void>((resolve) => {
      releaseReconnectContext = resolve;
    });
    let markReplayAudioSent!: () => void;
    const replayAudioSent = new Promise<void>((resolve) => {
      markReplayAudioSent = resolve;
    });
    const capabilities = {
      streaming: { input: true, output: false, native: true },
      cancellation: { request: true, output: false, buffer: false, truncation: false },
      transports: ["websocket"],
      audio: { input: [PCM16_16K_MONO] },
    } satisfies ProviderCapabilities;
    const provider: SpeechToTextProvider = {
      name: "context-reconnect-stt",
      kind: "stt",
      version: "0.1.0",
      capabilities,
      supportsSttAgentContext: () => true,
      async open(_request: SttOpenRequest): Promise<SttStream> {
        openCount += 1;
        const generationNumber = openCount;
        if (generationNumber === 2) {
          markSecondOpenStarted();
          await secondOpenGate;
        }
        const events = new AsyncQueue<TranscriptEvent>();
        const order: string[] = [];
        generations.push({ order, events });
        return {
          events,
          timestampOrigin: "generation",
          async sendAudio(chunk) {
            if (generationNumber === 1) {
              throw providerError("stt.transport.write_failed", "generation failed", {
                provider: "context-reconnect-stt",
                retriable: true,
              });
            }
            order.push(`audio:${chunk.audio.bytes[0] ?? 0}`);
            markReplayAudioSent();
          },
          async updateAgentContext(context) {
            order.push(`context:${context}`);
            if (generationNumber === 2 && context === "newest context") {
              markReconnectContextStarted();
              await reconnectContextGate;
              order.push("context:done");
            }
          },
          async commit() {},
          async close() {
            events.close();
          },
        };
      },
    };
    const reconnecting = withSttReconnect(provider, {
      jitter: false,
      initialBackoffMs: 0,
      maxBackoffMs: 0,
      stableUptimeMs: 1,
      maxAttempts: 2,
      maxRecoveryDurationMs: 500,
    });
    const stream = await reconnecting.open({
      sessionId: "stt_context" as SessionId,
      format: PCM16_16K_MONO,
      interimResults: true,
    });
    const commands = stream as typeof stream & {
      updateAgentContext(context: string): Promise<void>;
    };

    await commands.updateAgentContext("earlier context");
    await stream.sendAudio(audioChunk(1));
    await secondOpenStarted;
    const latestContext = commands.updateAgentContext("latest context");
    const newestContext = commands.updateAgentContext("newest context");
    expect(latestContext).toBe(newestContext);
    releaseSecondOpen();
    await reconnectContextStarted;
    const replayedBeforeContextAcknowledgement = await Promise.race([
      replayAudioSent.then(() => true),
      new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
    ]);
    releaseReconnectContext();
    await newestContext;
    await waitFor(() => generations[1]?.order.length === 3);

    expect(replayedBeforeContextAcknowledgement).toBe(false);
    expect(generations[1]?.order).toEqual(["context:newest context", "context:done", "audio:1"]);
    await stream.close();
  });

  it("applies context updates admitted during reconnect bootstrap before replay audio", async () => {
    const generations: Array<{
      readonly order: string[];
      readonly events: AsyncQueue<TranscriptEvent>;
    }> = [];
    let openCount = 0;
    let commands: { updateAgentContext(context: string): Promise<void> } | undefined;
    let latestUpdate: Promise<void> | undefined;
    let latestOutcome: Promise<unknown> | undefined;
    let latestSettled = false;
    let markSecondOpenStarted!: () => void;
    const secondOpenStarted = new Promise<void>((resolve) => {
      markSecondOpenStarted = resolve;
    });
    let releaseSecondOpen!: () => void;
    const secondOpenGate = new Promise<void>((resolve) => {
      releaseSecondOpen = resolve;
    });
    let markFirstReplayContextStarted!: () => void;
    const firstReplayContextStarted = new Promise<void>((resolve) => {
      markFirstReplayContextStarted = resolve;
    });
    let releaseFirstReplayContext!: () => void;
    const firstReplayContextGate = new Promise<void>((resolve) => {
      releaseFirstReplayContext = resolve;
    });
    let markAlignedReplayContextStarted!: () => void;
    const alignedReplayContextStarted = new Promise<void>((resolve) => {
      markAlignedReplayContextStarted = resolve;
    });
    let releaseAlignedReplayContext!: () => void;
    const alignedReplayContextGate = new Promise<void>((resolve) => {
      releaseAlignedReplayContext = resolve;
    });
    const capabilities = {
      streaming: { input: true, output: false, native: true },
      cancellation: { request: true, output: false, buffer: false, truncation: false },
      transports: ["websocket"],
      audio: { input: [PCM16_16K_MONO] },
    } satisfies ProviderCapabilities;
    const provider: SpeechToTextProvider = {
      name: "context-bootstrap-race-stt",
      kind: "stt",
      version: "0.1.0",
      capabilities,
      supportsSttAgentContext: () => true,
      async open(): Promise<SttStream> {
        openCount += 1;
        const generationNumber = openCount;
        if (generationNumber === 2) {
          markSecondOpenStarted();
          await secondOpenGate;
        }
        const events = new AsyncQueue<TranscriptEvent>();
        const order: string[] = [];
        generations.push({ order, events });
        return {
          events,
          timestampOrigin: "generation",
          async sendAudio(chunk) {
            if (generationNumber === 1) {
              throw providerError("stt.transport.write_failed", "generation failed", {
                provider: "context-bootstrap-race-stt",
                retriable: true,
              });
            }
            order.push(`audio:${chunk.audio.bytes[0] ?? 0}`);
          },
          async updateAgentContext(context) {
            order.push(`context:${context}`);
            if (generationNumber === 2 && context === "latest queued") {
              latestUpdate = commands!.updateAgentContext("newest queued");
              latestOutcome = latestUpdate.then(
                () => undefined,
                (error: unknown) => error,
              );
              void latestOutcome.then(() => {
                latestSettled = true;
              });
              markFirstReplayContextStarted();
              await firstReplayContextGate;
            } else if (generationNumber === 2 && context === "newest queued") {
              markAlignedReplayContextStarted();
              await alignedReplayContextGate;
            }
          },
          async commit() {},
          async close() {
            events.close();
          },
        };
      },
    };
    const reconnecting = withSttReconnect(provider, {
      jitter: false,
      initialBackoffMs: 0,
      maxBackoffMs: 0,
      stableUptimeMs: 1,
      maxAttempts: 2,
      maxRecoveryDurationMs: 500,
    });
    const stream = await reconnecting.open({
      sessionId: "stt_context_bootstrap_race" as SessionId,
      format: PCM16_16K_MONO,
      interimResults: true,
    });
    commands = stream as typeof stream & { updateAgentContext(context: string): Promise<void> };

    await stream.sendAudio(audioChunk(1));
    await secondOpenStarted;
    const admittedUpdate = commands.updateAgentContext("latest queued");
    const admittedOutcome = admittedUpdate.then(
      () => undefined,
      (error: unknown) => error,
    );
    releaseSecondOpen();
    await firstReplayContextStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const audioPassedFirstContext = generations[1]?.order.includes("audio:1") ?? false;
    releaseFirstReplayContext();
    await alignedReplayContextStarted;
    const latestSettledByPriorWrite = latestSettled;
    const audioPassedLatestContext = generations[1]?.order.includes("audio:1") ?? false;
    releaseAlignedReplayContext();
    const [latestUpdateError, admittedUpdateError] = await Promise.all([
      latestOutcome,
      admittedOutcome,
    ]);
    await waitFor(() => generations[1]?.order.includes("audio:1") === true);
    await stream.close();

    expect(audioPassedFirstContext).toBe(false);
    expect(audioPassedLatestContext).toBe(false);
    expect(latestSettledByPriorWrite).toBe(false);
    expect(latestUpdateError).toBeUndefined();
    expect(admittedUpdateError).toBeUndefined();
    expect(generations[1]?.order).toEqual([
      "context:latest queued",
      "context:newest queued",
      "audio:1",
    ]);
  });

  it("recovers a live context write failure before replaying queued audio and reports it once", async () => {
    const orders: string[][] = [];
    let openCount = 0;
    let markReplayAudioSent!: () => void;
    const replayAudioSent = new Promise<void>((resolve) => {
      markReplayAudioSent = resolve;
    });
    const capabilities = {
      streaming: { input: true, output: false, native: true },
      cancellation: { request: true, output: false, buffer: false, truncation: false },
      transports: ["websocket"],
      audio: { input: [PCM16_16K_MONO] },
    } satisfies ProviderCapabilities;
    const provider: SpeechToTextProvider = {
      name: "context-recovery-stt",
      kind: "stt",
      version: "0.1.0",
      capabilities,
      supportsSttAgentContext: () => true,
      async open(): Promise<SttStream> {
        openCount += 1;
        const generation = openCount;
        const events = new AsyncQueue<TranscriptEvent>();
        const order: string[] = [];
        orders.push(order);
        return {
          events,
          timestampOrigin: "generation",
          async sendAudio(chunk) {
            order.push(`audio:${chunk.audio.bytes[0] ?? 0}`);
            if (generation === 2) markReplayAudioSent();
          },
          async updateAgentContext(context) {
            order.push(`context:${context}`);
            if (generation === 1) throw new Error("provider rejected context");
          },
          async commit() {},
          async close() {
            events.close();
          },
        };
      },
    };
    const reconnecting = withSttReconnect(provider, {
      jitter: false,
      initialBackoffMs: 0,
      maxBackoffMs: 0,
      stableUptimeMs: 1,
      maxAttempts: 2,
      maxRecoveryDurationMs: 500,
    });
    const stream = await reconnecting.open({
      sessionId: "stt_context_recovery" as SessionId,
      format: PCM16_16K_MONO,
      interimResults: true,
    });
    const commands = stream as typeof stream & {
      updateAgentContext(context: string): Promise<void>;
    };
    const contextErrors: string[] = [];
    const removeErrorListener = getSttRecoveryControl(stream)?.subscribeContextUpdateError?.(
      (error) => contextErrors.push(error.code),
    );
    const reportedErrors: string[] = [];

    const contextUpdate = commands.updateAgentContext("latest assistant reply").catch((error) => {
      reportedErrors.push("stt.context_update_failed");
      throw error;
    });
    await stream.sendAudio(audioChunk(9));
    await expect(contextUpdate).rejects.toMatchObject({ code: "stt.context_update_failed" });
    await replayAudioSent;
    await waitFor(() => getSttRecoveryControl(stream)?.state() === "healthy");
    await stream.close();
    removeErrorListener?.();

    expect(orders[0]).toEqual(["context:latest assistant reply"]);
    expect(orders[1]).toEqual(["context:latest assistant reply", "audio:9"]);
    expect(openCount).toBe(2);
    expect([...contextErrors, ...reportedErrors]).toEqual(["stt.context_update_failed"]);
  });

  it("bounds unconfirmed context writes and stops before later audio dispatch", async () => {
    let openCount = 0;
    let contextWrites = 0;
    let markContextStarted!: () => void;
    const contextStarted = new Promise<void>((resolve) => {
      markContextStarted = resolve;
    });
    const order: string[] = [];
    const capabilities = {
      streaming: { input: true, output: false, native: true },
      cancellation: { request: true, output: false, buffer: false, truncation: false },
      transports: ["websocket"],
      audio: { input: [PCM16_16K_MONO] },
    } satisfies ProviderCapabilities;
    const provider: SpeechToTextProvider = {
      name: "context-write-bound-stt",
      kind: "stt",
      version: "0.1.0",
      capabilities,
      supportsSttAgentContext: () => true,
      async open(): Promise<SttStream> {
        openCount += 1;
        const events = new AsyncQueue<TranscriptEvent>();
        return {
          events,
          timestampOrigin: "generation",
          async sendAudio(chunk) {
            order.push(`audio:${chunk.audio.bytes[0] ?? 0}`);
          },
          updateAgentContext() {
            contextWrites += 1;
            markContextStarted();
            return new Promise<void>(() => {});
          },
          async commit() {},
          async close() {
            events.close();
          },
        };
      },
    };
    const reconnecting = withSttReconnect(provider, {
      jitter: false,
      initialBackoffMs: 0,
      maxBackoffMs: 0,
      stableUptimeMs: 1,
      maxAttempts: 1,
      maxRecoveryDurationMs: 200,
      sendTimeoutMs: 10,
    });
    const stream = await reconnecting.open({
      sessionId: "stt_context_write_bound" as SessionId,
      format: PCM16_16K_MONO,
      interimResults: true,
    });
    const commands = stream as typeof stream & {
      updateAgentContext(context: string): Promise<void>;
    };

    const firstUpdate = commands.updateAgentContext("assistant reply");
    await contextStarted;
    await stream.sendAudio(audioChunk(4));
    const newerUpdate = commands.updateAgentContext("newer reply");
    await expect(newerUpdate).rejects.toMatchObject({
      code: "stt.context_update_failed",
    });
    await expect(firstUpdate).rejects.toMatchObject({ code: "stt.context_update_failed" });
    await stream.close();

    expect(openCount).toBe(2);
    expect(contextWrites).toBe(2);
    expect(order).toEqual([]);
  });

  it("recovers a rejected reconnect context update before replay audio", async () => {
    let openCount = 0;
    const contextErrors: string[] = [];
    const orders: string[][] = [];
    let markReplayAudioSent!: () => void;
    const replayAudioSent = new Promise<void>((resolve) => {
      markReplayAudioSent = resolve;
    });
    const capabilities = {
      streaming: { input: true, output: false, native: true },
      cancellation: { request: true, output: false, buffer: false, truncation: false },
      transports: ["websocket"],
      audio: { input: [PCM16_16K_MONO] },
    } satisfies ProviderCapabilities;
    const provider: SpeechToTextProvider = {
      name: "context-reconnect-cleanup-stt",
      kind: "stt",
      version: "0.1.0",
      capabilities,
      supportsSttAgentContext: () => true,
      async open(): Promise<SttStream> {
        openCount += 1;
        const generation = openCount;
        const order: string[] = [];
        orders.push(order);
        const events = new AsyncQueue<TranscriptEvent>();
        return {
          events,
          timestampOrigin: "generation",
          async sendAudio() {
            if (generation === 1) {
              throw providerError("stt.transport.write_failed", "generation failed", {
                provider: "context-reconnect-cleanup-stt",
                retriable: true,
              });
            }
            order.push("audio");
            if (generation === 3) markReplayAudioSent();
          },
          async updateAgentContext(context) {
            order.push(`context:${context}`);
            if (generation === 2) throw new Error("context update rejected");
          },
          async commit() {},
          async close() {
            events.close();
          },
        };
      },
    };
    const reconnecting = withSttReconnect(provider, {
      jitter: false,
      initialBackoffMs: 0,
      maxBackoffMs: 0,
      stableUptimeMs: 1,
      maxAttempts: 3,
      maxQuickFailures: 3,
      maxRecoveryDurationMs: 500,
      sendTimeoutMs: 10,
    });
    const stream = await reconnecting.open({
      sessionId: "stt_context_cleanup" as SessionId,
      format: PCM16_16K_MONO,
      interimResults: true,
    });
    const removeErrorListener = getSttRecoveryControl(stream)?.subscribeContextUpdateError?.(
      (error) => contextErrors.push(error.code),
    );

    await expect(stream.updateAgentContext!("assistant reply")).resolves.toBeUndefined();
    await expect(stream.sendAudio(audioChunk(1))).resolves.toBeUndefined();
    await replayAudioSent;
    await waitFor(() => contextErrors.length === 1);
    await waitFor(() => getSttRecoveryControl(stream)?.state() === "healthy");
    await stream.close();
    removeErrorListener?.();

    expect(openCount).toBe(3);
    expect(orders[1]).toEqual(["context:assistant reply"]);
    expect(orders[2]).toEqual(["context:assistant reply", "audio"]);
    expect(contextErrors).toEqual(["stt.context_update_failed"]);
  });

  it("reopens after an unconfirmed reconnect context enqueue before replaying audio", async () => {
    let openCount = 0;
    const generations: Array<{ order: string[]; events: AsyncQueue<TranscriptEvent> }> = [];
    let markThirdGenerationAudioSent!: () => void;
    const thirdGenerationAudioSent = new Promise<void>((resolve) => {
      markThirdGenerationAudioSent = resolve;
    });
    const capabilities = {
      streaming: { input: true, output: false, native: true },
      cancellation: { request: true, output: false, buffer: false, truncation: false },
      transports: ["websocket"],
      audio: { input: [PCM16_16K_MONO] },
    } satisfies ProviderCapabilities;
    const provider: SpeechToTextProvider = {
      name: "context-timeout-fence-stt",
      kind: "stt",
      version: "0.1.0",
      capabilities,
      supportsSttAgentContext: () => true,
      async open(): Promise<SttStream> {
        openCount += 1;
        const generation = openCount;
        const events = new AsyncQueue<TranscriptEvent>();
        const order: string[] = [];
        generations.push({ order, events });
        return {
          events,
          timestampOrigin: "generation",
          async sendAudio(chunk) {
            order.push(`audio:${chunk.audio.bytes[0] ?? 0}`);
            if (generation === 1) {
              throw providerError("stt.transport.write_failed", "generation failed", {
                provider: "context-timeout-fence-stt",
                retriable: true,
              });
            }
            if (generation === 3) markThirdGenerationAudioSent();
          },
          async updateAgentContext(context) {
            order.push(`context:${context}`);
            if (generation === 2) await new Promise<void>(() => undefined);
          },
          async commit() {},
          async close() {
            events.close();
          },
        };
      },
    };
    const reconnecting = withSttReconnect(provider, {
      jitter: false,
      initialBackoffMs: 0,
      maxBackoffMs: 0,
      stableUptimeMs: 1,
      maxAttempts: 3,
      maxQuickFailures: 3,
      maxRecoveryDurationMs: 500,
      sendTimeoutMs: 10,
    });
    const stream = await reconnecting.open({
      sessionId: "stt_context_timeout_fence" as SessionId,
      format: PCM16_16K_MONO,
      interimResults: true,
    });

    await stream.updateAgentContext!("latest assistant reply");
    await stream.sendAudio(audioChunk(1));
    await thirdGenerationAudioSent;
    await waitFor(() => getSttRecoveryControl(stream)?.state() === "healthy");
    await stream.close();

    expect(openCount).toBe(3);
    expect(generations[1]?.order).toEqual(["context:latest assistant reply"]);
    expect(generations[2]?.order).toEqual(["context:latest assistant reply", "audio:1"]);
  });

  it("holds reconnect audio until local context enqueue is confirmed", async () => {
    const order: string[] = [];
    let markContextStarted!: () => void;
    const contextStarted = new Promise<void>((resolve) => {
      markContextStarted = resolve;
    });
    let releaseContext!: () => void;
    const contextGate = new Promise<void>((resolve) => {
      releaseContext = resolve;
    });
    const capabilities = {
      streaming: { input: true, output: false, native: true },
      cancellation: { request: true, output: false, buffer: false, truncation: false },
      transports: ["websocket"],
      audio: { input: [PCM16_16K_MONO] },
    } satisfies ProviderCapabilities;
    const provider: SpeechToTextProvider = {
      name: "slow-context-stt",
      kind: "stt",
      version: "0.1.0",
      capabilities,
      supportsSttAgentContext: () => true,
      async open(): Promise<SttStream> {
        return {
          events: new AsyncQueue<TranscriptEvent>(),
          timestampOrigin: "generation",
          async sendAudio(chunk) {
            order.push(`audio:${chunk.audio.bytes[0] ?? 0}`);
          },
          async updateAgentContext() {
            order.push("context:start");
            markContextStarted();
            await contextGate;
            order.push("context:done");
          },
          async commit() {},
          async close() {},
        };
      },
    };
    const reconnecting = withSttReconnect(provider, {
      jitter: false,
      initialBackoffMs: 0,
      maxBackoffMs: 0,
      stableUptimeMs: 1,
      maxAttempts: 1,
      maxRecoveryDurationMs: 500,
    });
    const stream = await reconnecting.open({
      sessionId: "stt_context_slow" as SessionId,
      format: PCM16_16K_MONO,
      interimResults: true,
    });
    const commands = stream as typeof stream & {
      updateAgentContext(context: string): Promise<void>;
    };

    const contextUpdate = commands.updateAgentContext("assistant reply");
    await contextStarted;
    await stream.sendAudio(audioChunk(3));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const audioPassedContext = order.includes("audio:3");
    releaseContext();
    await contextUpdate;
    await waitFor(() => order.includes("audio:3"));
    await stream.close();

    expect(audioPassedContext).toBe(false);
    expect(order).toEqual(["context:start", "context:done", "audio:3"]);
  });

  it("skips canceled queued context updates and never dispatches an already-aborted update", async () => {
    const order: string[] = [];
    let markAudioStarted!: () => void;
    const audioStarted = new Promise<void>((resolve) => {
      markAudioStarted = resolve;
    });
    let releaseAudio!: () => void;
    const audioGate = new Promise<void>((resolve) => {
      releaseAudio = resolve;
    });
    const capabilities = {
      streaming: { input: true, output: false, native: true },
      cancellation: { request: true, output: false, buffer: false, truncation: false },
      transports: ["websocket"],
      audio: { input: [PCM16_16K_MONO] },
    } satisfies ProviderCapabilities;
    const provider: SpeechToTextProvider = {
      name: "canceled-context-stt",
      kind: "stt",
      version: "0.1.0",
      capabilities,
      supportsSttAgentContext: () => true,
      async open(): Promise<SttStream> {
        const events = new AsyncQueue<TranscriptEvent>();
        return {
          events,
          timestampOrigin: "generation",
          async sendAudio(chunk) {
            order.push(`audio:start:${chunk.audio.bytes[0] ?? 0}`);
            if (chunk.audio.bytes[0] === 1) {
              markAudioStarted();
              await audioGate;
            }
            order.push(`audio:done:${chunk.audio.bytes[0] ?? 0}`);
          },
          async updateAgentContext(context) {
            order.push(`context:${context}`);
          },
          async commit() {},
          async close() {
            events.close();
          },
        };
      },
    };
    const reconnecting = withSttReconnect(provider, {
      jitter: false,
      initialBackoffMs: 0,
      maxBackoffMs: 0,
      stableUptimeMs: 1,
      maxAttempts: 1,
      maxRecoveryDurationMs: 500,
    });
    const stream = await reconnecting.open({
      sessionId: "stt_context_cancel_queued" as SessionId,
      format: PCM16_16K_MONO,
      interimResults: true,
    });
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();

    await expect(
      stream.updateAgentContext!("never dispatched", { signal: alreadyAborted.signal }),
    ).rejects.toMatchObject({ code: "stt.context_update_failed", retriable: true });

    const audioWrite = stream.sendAudio(audioChunk(1));
    await audioStarted;
    const controller = new AbortController();
    const contextUpdate = stream.updateAgentContext!("stale context", {
      signal: controller.signal,
    });
    controller.abort();
    await expect(contextUpdate).rejects.toMatchObject({
      code: "stt.context_update_failed",
      retriable: true,
    });
    releaseAudio();
    await audioWrite;
    await stream.sendAudio(audioChunk(2));
    await stream.close();

    expect(order).toEqual(["audio:start:1", "audio:done:1", "audio:start:2", "audio:done:2"]);
  });

  it("restores the previous context when an in-flight provider write ignores cancellation", async () => {
    const order: string[] = [];
    const updates: Array<{
      generation: number;
      context: string;
      signal?: AbortSignal | undefined;
    }> = [];
    let generation = 0;
    let markContextStarted!: () => void;
    const contextStarted = new Promise<void>((resolve) => {
      markContextStarted = resolve;
    });
    let releaseFirstUpdate!: () => void;
    const firstUpdateGate = new Promise<void>((resolve) => {
      releaseFirstUpdate = resolve;
    });
    let markLateWriteApplied!: () => void;
    const lateWriteApplied = new Promise<void>((resolve) => {
      markLateWriteApplied = resolve;
    });
    const capabilities = {
      streaming: { input: true, output: false, native: true },
      cancellation: { request: true, output: false, buffer: false, truncation: false },
      transports: ["websocket"],
      audio: { input: [PCM16_16K_MONO] },
    } satisfies ProviderCapabilities;
    const provider: SpeechToTextProvider = {
      name: "inflight-canceled-context-stt",
      kind: "stt",
      version: "0.1.0",
      capabilities,
      supportsSttAgentContext: () => true,
      async open(): Promise<SttStream> {
        const currentGeneration = ++generation;
        const events = new AsyncQueue<TranscriptEvent>();
        return {
          events,
          timestampOrigin: "generation",
          async sendAudio(chunk) {
            order.push(`audio:${chunk.audio.bytes[0] ?? 0}`);
          },
          async updateAgentContext(context, options) {
            updates.push({ generation: currentGeneration, context, signal: options?.signal });
            if (currentGeneration === 1 && context === "cancel this context") {
              markContextStarted();
              // Model a provider that accepted the context but cannot cancel an in-flight write.
              await firstUpdateGate;
              order.push(`late-context:${currentGeneration}:${context}`);
              markLateWriteApplied();
              return;
            }
            order.push(`context:${currentGeneration}:${context}`);
          },
          async commit() {},
          async close() {
            events.close();
          },
        };
      },
    };
    const reconnecting = withSttReconnect(provider, {
      jitter: false,
      initialBackoffMs: 0,
      maxBackoffMs: 0,
      stableUptimeMs: 1,
      maxAttempts: 1,
      maxRecoveryDurationMs: 500,
    });
    const stream = await reconnecting.open({
      sessionId: "stt_context_cancel_inflight" as SessionId,
      format: PCM16_16K_MONO,
      interimResults: true,
    });
    await stream.updateAgentContext!("previous context");
    const controller = new AbortController();
    const contextUpdate = stream.updateAgentContext!("cancel this context", {
      signal: controller.signal,
    });
    await contextStarted;
    controller.abort();

    await expect(contextUpdate).rejects.toMatchObject({
      code: "stt.context_update_failed",
      retriable: true,
    });
    await stream.sendAudio(audioChunk(3));
    await waitFor(() => order.includes("audio:3"));
    releaseFirstUpdate();
    await lateWriteApplied;
    await stream.close();

    expect(updates[1]?.signal?.aborted).toBe(true);
    expect(
      updates.map(({ generation: updateGeneration, context }) => [updateGeneration, context]),
    ).toEqual([
      [1, "previous context"],
      [1, "cancel this context"],
      [2, "previous context"],
    ]);
    expect(order).toEqual([
      "context:1:previous context",
      "context:2:previous context",
      "audio:3",
      "late-context:1:cancel this context",
    ]);
  });

  it("does not replay an in-flight context canceled before a cooperative provider writes it", async () => {
    const updates: Array<{ generation: number; context: string }> = [];
    const order: string[] = [];
    let generation = 0;
    let markContextStarted!: () => void;
    const contextStarted = new Promise<void>((resolve) => {
      markContextStarted = resolve;
    });
    const capabilities = {
      streaming: { input: true, output: false, native: true },
      cancellation: { request: true, output: false, buffer: false, truncation: false },
      transports: ["websocket"],
      audio: { input: [PCM16_16K_MONO] },
    } satisfies ProviderCapabilities;
    const provider: SpeechToTextProvider = {
      name: "cooperative-canceled-context-stt",
      kind: "stt",
      version: "0.1.0",
      capabilities,
      supportsSttAgentContext: () => true,
      async open(): Promise<SttStream> {
        const currentGeneration = ++generation;
        const events = new AsyncQueue<TranscriptEvent>();
        return {
          events,
          timestampOrigin: "generation",
          async sendAudio(chunk) {
            order.push(`audio:${chunk.audio.bytes[0] ?? 0}`);
          },
          async updateAgentContext(context, options) {
            updates.push({ generation: currentGeneration, context });
            if (context === "cancel this context") {
              markContextStarted();
              await new Promise<void>((_resolve, reject) => {
                const signal = options?.signal;
                if (signal?.aborted) {
                  order.push("cancelled-before-write");
                  reject(signal.reason);
                  return;
                }
                signal?.addEventListener(
                  "abort",
                  () => {
                    order.push("cancelled-before-write");
                    reject(signal.reason);
                  },
                  { once: true },
                );
              });
            }
            order.push(`context:${currentGeneration}:${context}`);
          },
          async commit() {},
          async close() {
            events.close();
          },
        };
      },
    };
    const reconnecting = withSttReconnect(provider, {
      jitter: false,
      initialBackoffMs: 0,
      maxBackoffMs: 0,
      stableUptimeMs: 1,
      maxAttempts: 1,
      maxRecoveryDurationMs: 500,
    });
    const stream = await reconnecting.open({
      sessionId: "stt_context_cancel_cooperative" as SessionId,
      format: PCM16_16K_MONO,
      interimResults: true,
    });
    await stream.updateAgentContext!("previous context");
    const controller = new AbortController();
    const contextUpdate = stream.updateAgentContext!("cancel this context", {
      signal: controller.signal,
    });
    await contextStarted;
    controller.abort();

    await expect(contextUpdate).rejects.toMatchObject({
      code: "stt.context_update_failed",
      retriable: true,
    });
    await stream.sendAudio(audioChunk(4));
    await waitFor(() => order.includes("audio:4"));
    await stream.close();

    expect(updates).toEqual([
      { generation: 1, context: "previous context" },
      { generation: 1, context: "cancel this context" },
      { generation: 2, context: "previous context" },
    ]);
    expect(order).toEqual([
      "context:1:previous context",
      "cancelled-before-write",
      "context:2:previous context",
      "audio:4",
    ]);
  });

  it("keeps an accepted context when caller abort races waiter cleanup", async () => {
    const updates: Array<{ generation: number; context: string }> = [];
    const orders: string[][] = [];
    let generation = 0;
    let markReplayAudioSent!: () => void;
    const replayAudioSent = new Promise<void>((resolve) => {
      markReplayAudioSent = resolve;
    });
    const capabilities = {
      streaming: { input: true, output: false, native: true },
      cancellation: { request: true, output: false, buffer: false, truncation: false },
      transports: ["websocket"],
      audio: { input: [PCM16_16K_MONO] },
    } satisfies ProviderCapabilities;
    const provider: SpeechToTextProvider = {
      name: "accepted-context-abort-race-stt",
      kind: "stt",
      version: "0.1.0",
      capabilities,
      supportsSttAgentContext: () => true,
      async open(): Promise<SttStream> {
        const currentGeneration = ++generation;
        const events = new AsyncQueue<TranscriptEvent>();
        const order: string[] = [];
        orders.push(order);
        return {
          events,
          timestampOrigin: "generation",
          async sendAudio(chunk) {
            if (currentGeneration === 1) {
              throw providerError("stt.transport.write_failed", "restart after acceptance", {
                provider: "accepted-context-abort-race-stt",
                retriable: true,
              });
            }
            order.push(`audio:${chunk.audio.bytes[0] ?? 0}`);
            markReplayAudioSent();
          },
          async updateAgentContext(context) {
            updates.push({ generation: currentGeneration, context });
            order.push(`context:${currentGeneration}:${context}`);
          },
          async commit() {},
          async close() {
            events.close();
          },
        };
      },
    };
    const reconnecting = withSttReconnect(provider, {
      jitter: false,
      initialBackoffMs: 0,
      maxBackoffMs: 0,
      stableUptimeMs: 1,
      maxAttempts: 1,
      maxRecoveryDurationMs: 500,
    });
    const stream = await reconnecting.open({
      sessionId: "stt_context_abort_after_acceptance" as SessionId,
      format: PCM16_16K_MONO,
      interimResults: true,
    });
    await stream.updateAgentContext!("previous context");

    const controller = new AbortController();
    const signal = controller.signal;
    const removeEventListener = signal.removeEventListener.bind(signal);
    let removeCalls = 0;
    signal.removeEventListener = (type, listener, options) => {
      removeCalls += 1;
      if (type === "abort" && removeCalls === 2) controller.abort();
      removeEventListener(type, listener, options);
    };

    await stream.updateAgentContext!("accepted context", { signal });
    expect(signal.aborted).toBe(true);

    await stream.sendAudio(audioChunk(5));
    await replayAudioSent;
    await waitFor(() => getSttRecoveryControl(stream)?.state() === "healthy");
    await stream.close();

    expect(updates).toEqual([
      { generation: 1, context: "previous context" },
      { generation: 1, context: "accepted context" },
      { generation: 2, context: "accepted context" },
    ]);
    expect(orders[1]).toEqual(["context:2:accepted context", "audio:5"]);
  });

  it("fences a rejected provider handoff when abort lands before journal handling", async () => {
    const updates: Array<{ generation: number; context: string }> = [];
    const orders: string[][] = [];
    let generation = 0;
    let markReplayAudioSent!: () => void;
    const replayAudioSent = new Promise<void>((resolve) => {
      markReplayAudioSent = resolve;
    });
    const capabilities = {
      streaming: { input: true, output: false, native: true },
      cancellation: { request: true, output: false, buffer: false, truncation: false },
      transports: ["websocket"],
      audio: { input: [PCM16_16K_MONO] },
    } satisfies ProviderCapabilities;
    const provider: SpeechToTextProvider = {
      name: "rejected-context-abort-race-stt",
      kind: "stt",
      version: "0.1.0",
      capabilities,
      supportsSttAgentContext: () => true,
      async open(): Promise<SttStream> {
        const currentGeneration = ++generation;
        const events = new AsyncQueue<TranscriptEvent>();
        const order: string[] = [];
        orders.push(order);
        return {
          events,
          timestampOrigin: "generation",
          async sendAudio(chunk) {
            order.push(`audio:${chunk.audio.bytes[0] ?? 0}`);
            if (currentGeneration === 2) markReplayAudioSent();
          },
          async updateAgentContext(context) {
            updates.push({ generation: currentGeneration, context });
            order.push(`context:${currentGeneration}:${context}`);
            if (currentGeneration === 1 && context === "rejected context") {
              throw new Error("provider rejected context");
            }
          },
          async commit() {},
          async close() {
            events.close();
          },
        };
      },
    };
    const reconnecting = withSttReconnect(provider, {
      jitter: false,
      initialBackoffMs: 0,
      maxBackoffMs: 0,
      stableUptimeMs: 1,
      maxAttempts: 1,
      maxRecoveryDurationMs: 500,
    });
    const stream = await reconnecting.open({
      sessionId: "stt_context_rejected_abort_race" as SessionId,
      format: PCM16_16K_MONO,
      interimResults: true,
    });
    await stream.updateAgentContext!("previous context");

    const controller = new AbortController();
    const signal = controller.signal;
    const removeEventListener = signal.removeEventListener.bind(signal);
    let removeCalls = 0;
    signal.removeEventListener = (type, listener, options) => {
      removeCalls += 1;
      // The provider rejection is normalized before the handoff listeners detach.
      // Abort during that detach, before #runJournal handles the rejection.
      if (type === "abort" && removeCalls === 1) controller.abort();
      removeEventListener(type, listener, options);
    };

    await expect(stream.updateAgentContext!("rejected context", { signal })).rejects.toMatchObject({
      code: "stt.context_update_failed",
    });
    expect(signal.aborted).toBe(true);

    await stream.sendAudio(audioChunk(7));
    await waitFor(() => generation === 2);
    await replayAudioSent;
    await waitFor(() => getSttRecoveryControl(stream)?.state() === "healthy");
    await stream.close();

    expect(updates).toEqual([
      { generation: 1, context: "previous context" },
      { generation: 1, context: "rejected context" },
      { generation: 2, context: "previous context" },
    ]);
    expect(orders[1]).toEqual(["context:2:previous context", "audio:7"]);
  });

  it("keeps provider acceptance when abort is queued before journal settlement", async () => {
    const updates: Array<{ generation: number; context: string }> = [];
    const orders: string[][] = [];
    let generation = 0;
    let markAcceptedUpdateStarted!: () => void;
    const acceptedUpdateStarted = new Promise<void>((resolve) => {
      markAcceptedUpdateStarted = resolve;
    });
    let acceptProviderContext!: () => void;
    let markReplayAudioSent!: () => void;
    const replayAudioSent = new Promise<void>((resolve) => {
      markReplayAudioSent = resolve;
    });
    const capabilities = {
      streaming: { input: true, output: false, native: true },
      cancellation: { request: true, output: false, buffer: false, truncation: false },
      transports: ["websocket"],
      audio: { input: [PCM16_16K_MONO] },
    } satisfies ProviderCapabilities;
    const provider: SpeechToTextProvider = {
      name: "provider-acceptance-abort-race-stt",
      kind: "stt",
      version: "0.1.0",
      capabilities,
      supportsSttAgentContext: () => true,
      async open(): Promise<SttStream> {
        const currentGeneration = ++generation;
        const events = new AsyncQueue<TranscriptEvent>();
        const order: string[] = [];
        orders.push(order);
        return {
          events,
          timestampOrigin: "generation",
          async sendAudio(chunk) {
            if (currentGeneration === 1) {
              throw providerError("stt.transport.write_failed", "restart after acceptance", {
                provider: "provider-acceptance-abort-race-stt",
                retriable: true,
              });
            }
            order.push(`audio:${chunk.audio.bytes[0] ?? 0}`);
            markReplayAudioSent();
          },
          updateAgentContext(context) {
            updates.push({ generation: currentGeneration, context });
            order.push(`context:${currentGeneration}:${context}`);
            if (currentGeneration === 1 && context === "accepted context") {
              markAcceptedUpdateStarted();
              return new Promise<void>((resolve) => {
                acceptProviderContext = resolve;
              });
            }
            return Promise.resolve();
          },
          async commit() {},
          async close() {
            events.close();
          },
        };
      },
    };
    const reconnecting = withSttReconnect(provider, {
      jitter: false,
      initialBackoffMs: 0,
      maxBackoffMs: 0,
      stableUptimeMs: 1,
      maxAttempts: 1,
      maxRecoveryDurationMs: 500,
    });
    const stream = await reconnecting.open({
      sessionId: "stt_context_accept_before_settlement" as SessionId,
      format: PCM16_16K_MONO,
      interimResults: true,
    });
    await stream.updateAgentContext!("previous context");
    const controller = new AbortController();
    const contextUpdate = stream.updateAgentContext!("accepted context", {
      signal: controller.signal,
    });
    await acceptedUpdateStarted;

    acceptProviderContext();
    queueMicrotask(() => controller.abort());
    await expect(contextUpdate).resolves.toBeUndefined();
    expect(controller.signal.aborted).toBe(true);

    await stream.sendAudio(audioChunk(6));
    await replayAudioSent;
    await waitFor(() => getSttRecoveryControl(stream)?.state() === "healthy");
    await stream.close();

    expect(updates).toEqual([
      { generation: 1, context: "previous context" },
      { generation: 1, context: "accepted context" },
      { generation: 2, context: "accepted context" },
    ]);
    expect(orders[1]).toEqual(["context:2:accepted context", "audio:6"]);
  });
});

function audioChunk(value: number): InputAudioChunk {
  return createMediaEvent({
    id: `audio_${value}` as never,
    type: "media.audio.chunk",
    sessionId: "stt_context" as SessionId,
    sequence: value,
    direction: "input",
    timestamp: TS,
    monotonicOffsetMs: value,
    audio: {
      format: PCM16_16K_MONO,
      durationMs: 1,
      frameCount: 16,
      bytes: new Uint8Array([value, 0]),
    },
  }) as InputAudioChunk;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not reached");
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}
