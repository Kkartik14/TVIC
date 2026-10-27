import { describe, expect, it } from "vitest";

import {
  PCM16_16K_MONO,
  createMediaEvent,
  providerError,
  STT_ERROR_CODES,
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
import {
  boundSttAgentContext,
  coalescePendingSttAgentContext,
  DEFAULT_STT_AGENT_CONTEXT_TIMEOUT_MS,
  updateSttAgentContext,
  validateSttAgentContext,
} from "../src/stt-agent-context.js";
import { TS } from "./harness.js";

interface ContextCommandController extends SerialSttCommandController {
  admitAgentContext(context: string): Promise<void>;
}

describe("STT agent context commands", () => {
  it("shares validation and the default serial context deadline", () => {
    expect(DEFAULT_STT_AGENT_CONTEXT_TIMEOUT_MS).toBe(2_000);
    expect(validateSttAgentContext("🙂".repeat(1_500))).toBeUndefined();
    expect(validateSttAgentContext("🙂".repeat(1_501), "test-stt")).toMatchObject({
      code: STT_ERROR_CODES.invalidRequest,
      provider: "test-stt",
    });
    expect(validateSttAgentContext(42 as unknown)).toMatchObject({
      code: STT_ERROR_CODES.invalidRequest,
    });
  });

  it("coalesces only eligible pending context items", () => {
    const candidates: Array<{ readonly kind: "audio" } | { kind: "context"; context: string }> = [
      { kind: "audio" },
      { kind: "context", context: "older context" },
    ];

    const result = coalescePendingSttAgentContext(
      candidates,
      "latest context",
      (candidate): candidate is Extract<(typeof candidates)[number], { kind: "context" }> =>
        candidate.kind === "context",
    );

    expect(result).toBe(candidates[1]);
    expect(candidates[1]).toMatchObject({ context: "latest context" });
  });

  it("aborts an unaccepted provider context write when its shared deadline expires", async () => {
    let providerSignal: AbortSignal | undefined;
    const stream: SttStream & {
      updateAgentContext(context: string, options?: { signal?: AbortSignal }): Promise<void>;
    } = {
      events: new AsyncQueue<TranscriptEvent>(),
      async sendAudio() {},
      async updateAgentContext(_context, options) {
        providerSignal = options?.signal;
        await new Promise<void>(() => undefined);
      },
      async commit() {},
      async close() {},
    };

    await expect(updateSttAgentContext(stream, "context", { timeoutMs: 10 })).rejects.toMatchObject(
      { code: STT_ERROR_CODES.contextUpdateFailed, category: "timeout" },
    );
    expect(providerSignal?.aborted).toBe(true);
  });

  it("aborts the serial provider signal after a definite context rejection", async () => {
    let providerSignal: AbortSignal | undefined;
    const stream: SttStream & {
      updateAgentContext(context: string, options?: { signal?: AbortSignal }): Promise<void>;
    } = {
      events: new AsyncQueue<TranscriptEvent>(),
      async sendAudio() {},
      async updateAgentContext(_context, options) {
        providerSignal = options?.signal;
        throw new Error("definite provider rejection");
      },
      async commit() {},
      async close() {},
    };

    await expect(updateSttAgentContext(stream, "context", { timeoutMs: 100 })).rejects.toThrow(
      "definite provider rejection",
    );
    expect(providerSignal?.aborted).toBe(true);
  });

  it("stops caller cancellation after the provider accepts the context", async () => {
    const caller = new AbortController();
    let providerSignal: AbortSignal | undefined;
    let accept!: () => void;
    let accepted = false;
    const stream: SttStream & {
      updateAgentContext(context: string, options?: { signal?: AbortSignal }): Promise<void>;
    } = {
      events: new AsyncQueue<TranscriptEvent>(),
      async sendAudio() {},
      updateAgentContext(_context, options) {
        providerSignal = options?.signal;
        return new Promise<void>((resolve) => {
          accept = resolve;
        });
      },
      async commit() {},
      async close() {},
    };
    const write = updateSttAgentContext(stream, "context", {
      timeoutMs: 1_000,
      callerSignal: caller.signal,
      onProviderAccepted: () => {
        accepted = true;
      },
    });

    accept();
    await write;
    caller.abort();

    expect(accepted).toBe(true);
    expect(providerSignal?.aborted).toBe(false);
  });

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

    expect(audioPassedContext).toBe(true);
    expect(order).toEqual(["context:start", "audio:1", "context:done"]);
  });

  it("keeps context writes ordered without delaying admitted caller audio", async () => {
    const order: string[] = [];
    let markFirstContextStarted!: () => void;
    const firstContextStarted = new Promise<void>((resolve) => {
      markFirstContextStarted = resolve;
    });
    let releaseFirstContext!: () => void;
    const firstContextGate = new Promise<void>((resolve) => {
      releaseFirstContext = resolve;
    });
    const stream: SttStream = {
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

    expect(audioPassedPendingContext).toBe(true);
    expect(alignedPrefixError).toBeUndefined();
    expect(order).toEqual([
      "context:full response",
      "audio:5",
      "context:full response accepted",
      "context:heard prefix",
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

  it("bounds drain time and settles context writes queued behind a slow update", async () => {
    const providerCalls: string[] = [];
    let closeCalls = 0;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const stream: SttStream = {
      events: new AsyncQueue<TranscriptEvent>(),
      async sendAudio() {},
      async updateAgentContext(context, options) {
        providerCalls.push(context);
        if (context !== "first") return;
        markFirstStarted();
        await new Promise<void>((resolve) => {
          const signal = options?.signal;
          if (signal?.aborted) resolve();
          else signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
      async commit() {},
      async close() {
        closeCalls += 1;
      },
    };
    const controller = new SerialSttCommandController({
      stream,
      closeTimeoutMs: 30,
      contextUpdateTimeoutMs: 750,
    }) as ContextCommandController;
    const updates = [controller.admitAgentContext("first")];
    await firstStarted;
    updates.push(controller.admitAgentContext("second"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    updates.push(controller.admitAgentContext("third"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const outcomes = Promise.all(
      updates.map((update) =>
        update.then(
          () => ({ kind: "resolved" as const }),
          (error: unknown) => ({ kind: "rejected" as const, error }),
        ),
      ),
    );

    const startedAt = Date.now();
    await expect(controller.drain()).rejects.toMatchObject({ code: "stt.drain_timeout" });
    const elapsedMs = Date.now() - startedAt;
    const settled = await outcomes;

    expect(elapsedMs).toBeLessThan(500);
    expect(settled).toMatchObject([
      { kind: "rejected", error: { code: "stt.drain_timeout" } },
      { kind: "rejected", error: { code: "stt.drain_timeout" } },
      { kind: "rejected", error: { code: "stt.drain_timeout" } },
    ]);
    expect(providerCalls).toEqual(["first"]);
    expect(closeCalls).toBe(1);
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
      retriable: false,
    });
    await controller.admitAudio(audioChunk(7));
    await waitFor(() => audioValues.length === 1);
    await controller.drain();

    expect(failed).toBe(false);
    expect(audioValues).toEqual([7]);
  });

  it("classifies missing context-update methods as non-retriable in both controllers", async () => {
    let directAudioWrites = 0;
    const unsupportedStream: SttStream = {
      events: new AsyncQueue<TranscriptEvent>(),
      timestampOrigin: "generation",
      async sendAudio() {
        directAudioWrites += 1;
      },
      async commit() {},
      async close() {},
    };
    const serial = new SerialSttCommandController({ stream: unsupportedStream });
    await expect(serial.admitAgentContext("context")).rejects.toMatchObject({
      code: "stt.context_update_failed",
      retriable: false,
    });
    await serial.admitAudio(audioChunk(1));
    await serial.drain();

    let openCount = 0;
    const capabilities = {
      streaming: { input: true, output: false, native: true },
      cancellation: { request: true, output: false, buffer: false, truncation: false },
      transports: ["websocket"],
      audio: { input: [PCM16_16K_MONO] },
    } satisfies ProviderCapabilities;
    const provider: SpeechToTextProvider = {
      name: "missing-context-method-stt",
      kind: "stt",
      version: "0.1.0",
      capabilities,
      supportsSttAgentContext: () => true,
      async open() {
        openCount += 1;
        return { ...unsupportedStream, events: new AsyncQueue<TranscriptEvent>() };
      },
    };
    const stream = await withSttReconnect(provider, { jitter: false }).open({
      sessionId: "stt_context_method_missing" as SessionId,
      format: PCM16_16K_MONO,
      interimResults: true,
    });
    await expect(stream.updateAgentContext!("context")).rejects.toMatchObject({
      code: "stt.context_update_failed",
      retriable: false,
    });
    await stream.sendAudio(audioChunk(2));
    await waitFor(() => directAudioWrites === 2);
    await stream.close();

    expect(openCount).toBe(1);
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

  it("continues replayed caller audio while reconnect context is pending", async () => {
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
    await waitFor(() => generations[1]?.order.includes("context:done") === true);

    expect(replayedBeforeContextAcknowledgement).toBe(true);
    expect(generations[1]?.order).toContain("audio:1");
    expect(generations[1]?.order).toContain("context:newest context");
    expect(generations[1]?.order).not.toContain("context:earlier context");
    expect(generations[1]?.order.indexOf("context:newest context")).toBeLessThan(
      generations[1]?.order.indexOf("context:done") ?? -1,
    );
    await stream.close();
  });

  it("keeps caller audio moving when a context replay is aborted during probation", async () => {
    let openCount = 0;
    const closedGenerations: boolean[] = [];
    const audioCalls: Array<{ generation: number; value: number }> = [];
    let markSecondOpenStarted!: () => void;
    const secondOpenStarted = new Promise<void>((resolve) => {
      markSecondOpenStarted = resolve;
    });
    let releaseSecondOpen!: () => void;
    const secondOpenGate = new Promise<void>((resolve) => {
      releaseSecondOpen = resolve;
    });
    let markContextReplayStarted!: () => void;
    const contextReplayStarted = new Promise<void>((resolve) => {
      markContextReplayStarted = resolve;
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
      name: "context-probation-abort-stt",
      kind: "stt",
      version: "test",
      capabilities,
      supportsSttAgentContext: () => true,
      async open(): Promise<SttStream> {
        const generation = ++openCount;
        if (generation === 2) {
          markSecondOpenStarted();
          await secondOpenGate;
        }
        closedGenerations[generation - 1] = false;
        const events = new AsyncQueue<TranscriptEvent>();
        return {
          events,
          timestampOrigin: "generation",
          async sendAudio(chunk) {
            const value = chunk.audio.bytes[0] ?? 0;
            if (generation === 1) {
              throw providerError("stt.transport.write_failed", "restart for abort case", {
                provider: "context-probation-abort-stt",
                retriable: true,
              });
            }
            audioCalls.push({ generation, value });
            markReplayAudioSent();
          },
          async updateAgentContext(_context, options) {
            if (generation !== 2) return;
            markContextReplayStarted();
            await new Promise<void>((_resolve, reject) => {
              const signal = options?.signal;
              if (!signal) {
                reject(new Error("expected an abort signal for context replay"));
                return;
              }
              if (signal.aborted) {
                reject(signal.reason);
                return;
              }
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          },
          async commit() {},
          async close() {
            closedGenerations[generation - 1] = true;
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
      maxRecoveryDurationMs: 500,
    });
    const stream = await reconnecting.open({
      sessionId: "stt_context_probation_abort" as SessionId,
      format: PCM16_16K_MONO,
      interimResults: true,
    });

    await stream.sendAudio(audioChunk(1));
    await secondOpenStarted;
    const controller = new AbortController();
    const contextUpdate = stream.updateAgentContext!("context cancelled in probation", {
      signal: controller.signal,
    });
    releaseSecondOpen();
    await contextReplayStarted;
    controller.abort();

    await expect(contextUpdate).rejects.toMatchObject({ code: "stt.context_update_failed" });
    await stream.sendAudio(audioChunk(2));
    await replayAudioSent;
    await waitFor(() => getSttRecoveryControl(stream)?.state() === "healthy");
    const openedAtClose = openCount;
    await expect(stream.close()).resolves.toBeUndefined();

    expect(audioCalls.some(({ value }) => value === 2)).toBe(true);
    expect(openCount).toBe(openedAtClose);
    expect(closedGenerations).toHaveLength(openCount);
    expect(closedGenerations.every(Boolean)).toBe(true);
  });

  it("serializes reconnect context updates while replay audio proceeds", async () => {
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

    expect(audioPassedFirstContext).toBe(true);
    expect(audioPassedLatestContext).toBe(true);
    expect(latestSettledByPriorWrite).toBe(false);
    expect(latestUpdateError).toBeUndefined();
    expect(admittedUpdateError).toBeUndefined();
    expect(generations[1]?.order).toEqual([
      "context:latest queued",
      "audio:1",
      "context:newest queued",
    ]);
  });

  it("does not reconnect after a definite context rejection and reports it once", async () => {
    const orders: string[][] = [];
    let openCount = 0;
    let rejectedProviderSignal: AbortSignal | undefined;
    let markAudioSent!: () => void;
    const audioSent = new Promise<void>((resolve) => {
      markAudioSent = resolve;
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
            markAudioSent();
          },
          async updateAgentContext(context, options) {
            order.push(`context:${context}`);
            if (generation === 1) {
              rejectedProviderSignal = options?.signal;
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
    await audioSent;
    await waitFor(() => getSttRecoveryControl(stream)?.state() === "healthy");
    await stream.close();
    removeErrorListener?.();

    expect(orders[0]).toEqual(["context:latest assistant reply", "audio:9"]);
    expect(rejectedProviderSignal?.aborted).toBe(false);
    expect(openCount).toBe(1);
    expect([...contextErrors, ...reportedErrors]).toEqual(["stt.context_update_failed"]);
  });

  it("keeps audio replay healthy when optional context re-sends keep timing out", async () => {
    let openCount = 0;
    let contextWrites = 0;
    const stateHistory: string[] = [];
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
    getSttRecoveryControl(stream)?.subscribe((state) => stateHistory.push(state));
    const commands = stream as typeof stream & {
      updateAgentContext(context: string): Promise<void>;
    };

    const firstUpdate = commands.updateAgentContext("assistant reply");
    await contextStarted;
    await stream.sendAudio(audioChunk(4));
    const newerUpdate = commands.updateAgentContext("newer reply");
    const [newerOutcome, firstOutcome] = await Promise.all([
      newerUpdate.then(
        () => undefined,
        (error: unknown) => error,
      ),
      firstUpdate.then(
        () => undefined,
        (error: unknown) => error,
      ),
    ]);
    expect(newerOutcome).toMatchObject({ code: "stt.context_update_failed" });
    expect(firstOutcome).toMatchObject({ code: "stt.context_update_failed" });
    await waitFor(() => getSttRecoveryControl(stream)?.state() === "healthy");
    await stream.close();

    expect(openCount, stateHistory.join(" -> ")).toBe(2);
    expect(contextWrites).toBe(2);
    expect(order).toEqual(["audio:4", "audio:4"]);
  });

  it.each([
    ["succeeds", false],
    ["is rejected", true],
  ] as const)(
    "settles an aborted-signal context update superseded during reconnect when replay %s",
    async (_outcome, rejectReplay) => {
      let openCount = 0;
      const generations: Array<{ events: AsyncQueue<TranscriptEvent>; order: string[] }> = [];
      let markFirstContextStarted!: () => void;
      const firstContextStarted = new Promise<void>((resolve) => {
        markFirstContextStarted = resolve;
      });
      let markSecondOpenStarted!: () => void;
      const secondOpenStarted = new Promise<void>((resolve) => {
        markSecondOpenStarted = resolve;
      });
      let releaseSecondOpen!: () => void;
      const secondOpenGate = new Promise<void>((resolve) => {
        releaseSecondOpen = resolve;
      });
      const capabilities = {
        streaming: { input: true, output: false, native: true },
        cancellation: { request: true, output: false, buffer: false, truncation: false },
        transports: ["websocket"],
        audio: { input: [PCM16_16K_MONO] },
      } satisfies ProviderCapabilities;
      const provider: SpeechToTextProvider = {
        name: "context-superseded-on-reconnect-stt",
        kind: "stt",
        version: "0.1.0",
        capabilities,
        supportsSttAgentContext: () => true,
        async open(): Promise<SttStream> {
          openCount += 1;
          const generation = openCount;
          if (generation === 2) {
            markSecondOpenStarted();
            await secondOpenGate;
          }
          const events = new AsyncQueue<TranscriptEvent>();
          const order: string[] = [];
          generations.push({ events, order });
          return {
            events,
            timestampOrigin: "generation",
            async sendAudio() {},
            async updateAgentContext(context) {
              order.push(context);
              if (generation === 1) {
                markFirstContextStarted();
                await new Promise<void>(() => {});
              }
              if (generation === 2 && rejectReplay) {
                throw new Error("reconnect context replay rejected");
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
        maxRecoveryDurationMs: 1_000,
        sendTimeoutMs: 800,
      });
      const stream = await reconnecting.open({
        sessionId: "stt_context_superseded_reconnect" as SessionId,
        format: PCM16_16K_MONO,
        interimResults: true,
      });
      const controller = new AbortController();
      const firstUpdate = stream.updateAgentContext!("first context", {
        signal: controller.signal,
      });
      await firstContextStarted;
      generations[0]?.events.close();
      await secondOpenStarted;
      const latestUpdate = stream.updateAgentContext!("latest context");
      releaseSecondOpen();

      let firstSettled = false;
      let latestSettled = false;
      void firstUpdate.then(
        () => {
          firstSettled = true;
        },
        () => {
          firstSettled = true;
        },
      );
      void latestUpdate.then(
        () => {
          latestSettled = true;
        },
        () => {
          latestSettled = true;
        },
      );
      await waitFor(() => firstSettled && latestSettled);
      const outcomes = await Promise.allSettled([firstUpdate, latestUpdate]);
      await waitFor(() => getSttRecoveryControl(stream)?.state() === "healthy");
      await stream.close();

      expect(openCount).toBe(2);
      expect(generations[1]?.order).toEqual(["latest context"]);
      expect(outcomes.map((outcome) => outcome.status)).toEqual(
        rejectReplay ? ["rejected", "rejected"] : ["fulfilled", "fulfilled"],
      );
    },
  );

  it("keeps graceful close successful when an in-flight context update is aborted", async () => {
    let markContextStarted!: () => void;
    let markAudioStarted!: () => void;
    let releaseAudio!: () => void;
    const contextStarted = new Promise<void>((resolve) => {
      markContextStarted = resolve;
    });
    const audioStarted = new Promise<void>((resolve) => {
      markAudioStarted = resolve;
    });
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
      name: "context-abort-during-close-stt",
      kind: "stt",
      version: "0.1.0",
      capabilities,
      supportsSttAgentContext: () => true,
      async open(): Promise<SttStream> {
        const events = new AsyncQueue<TranscriptEvent>();
        return {
          events,
          timestampOrigin: "generation",
          async sendAudio() {
            markAudioStarted();
            await audioGate;
          },
          async updateAgentContext(_context, options) {
            markContextStarted();
            await new Promise<void>((_resolve, reject) => {
              const signal = options?.signal;
              if (signal?.aborted) {
                reject(signal.reason);
                return;
              }
              signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
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
      sessionId: "stt_context_abort_during_close" as SessionId,
      format: PCM16_16K_MONO,
      interimResults: true,
    });
    const controller = new AbortController();
    const update = stream.updateAgentContext!("cancel on close", {
      signal: controller.signal,
    });
    await contextStarted;
    const audioWrite = stream.sendAudio(audioChunk(1));
    await audioStarted;
    const close = stream.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();

    await expect(update).rejects.toMatchObject({ code: "stt.context_update_failed" });
    expect(getSttRecoveryControl(stream)?.state()).toBe("healthy");
    releaseAudio();
    await audioWrite;
    await expect(close).resolves.toBeUndefined();
    expect(getSttRecoveryControl(stream)?.state()).toBe("closed");
  });

  it("waits for a pending context write when close has no queued audio", async () => {
    let markContextStarted!: () => void;
    let releaseContext!: () => void;
    const contextStarted = new Promise<void>((resolve) => {
      markContextStarted = resolve;
    });
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
      name: "context-close-drain-stt",
      kind: "stt",
      version: "0.1.0",
      capabilities,
      supportsSttAgentContext: () => true,
      async open(): Promise<SttStream> {
        const events = new AsyncQueue<TranscriptEvent>();
        return {
          events,
          timestampOrigin: "generation",
          async sendAudio() {},
          async updateAgentContext() {
            markContextStarted();
            await contextGate;
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
      sessionId: "stt_context_close_drain" as SessionId,
      format: PCM16_16K_MONO,
      interimResults: true,
    });
    const contextUpdate = stream.updateAgentContext!("wait for this update");
    await contextStarted;

    let closeSettled = false;
    const close = stream.close().then(() => {
      closeSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closeSettled).toBe(false);
    releaseContext();

    await expect(contextUpdate).resolves.toBeUndefined();
    await expect(close).resolves.toBeUndefined();
    expect(getSttRecoveryControl(stream)?.state()).toBe("closed");
  });

  it("drains replay audio when a caller aborts a reconnect context write during close", async () => {
    let openCount = 0;
    const closedGenerations: boolean[] = [];
    let markInitialContextStarted!: () => void;
    const initialContextStarted = new Promise<void>((resolve) => {
      markInitialContextStarted = resolve;
    });
    let rejectInitialContext!: (error: unknown) => void;
    let markReplayContextStarted!: () => void;
    const replayContextStarted = new Promise<void>((resolve) => {
      markReplayContextStarted = resolve;
    });
    let markReplayAudioStarted!: () => void;
    const replayAudioStarted = new Promise<void>((resolve) => {
      markReplayAudioStarted = resolve;
    });
    let releaseReplayAudio!: () => void;
    const replayAudioGate = new Promise<void>((resolve) => {
      releaseReplayAudio = resolve;
    });
    const capabilities = {
      streaming: { input: true, output: false, native: true },
      cancellation: { request: true, output: false, buffer: false, truncation: false },
      transports: ["websocket"],
      audio: { input: [PCM16_16K_MONO] },
    } satisfies ProviderCapabilities;
    const provider: SpeechToTextProvider = {
      name: "context-replay-abort-close-stt",
      kind: "stt",
      version: "test",
      capabilities,
      supportsSttAgentContext: () => true,
      async open(): Promise<SttStream> {
        const generation = ++openCount;
        const events = new AsyncQueue<TranscriptEvent>();
        closedGenerations[generation - 1] = false;
        return {
          events,
          timestampOrigin: "generation",
          async sendAudio() {
            if (generation === 1) {
              throw providerError("stt.transport.write_failed", "restart for close race", {
                provider: "context-replay-abort-close-stt",
                retriable: true,
              });
            }
            markReplayAudioStarted();
            await replayAudioGate;
          },
          async updateAgentContext(_context, options) {
            if (generation === 1) {
              markInitialContextStarted();
              await new Promise<void>((_resolve, reject) => {
                rejectInitialContext = reject;
              });
              return;
            }
            markReplayContextStarted();
            await new Promise<void>((_resolve, reject) => {
              const signal = options?.signal;
              if (!signal) {
                reject(new Error("expected the caller signal for replayed context"));
                return;
              }
              if (signal.aborted) {
                reject(signal.reason);
                return;
              }
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          },
          async commit() {},
          async close() {
            closedGenerations[generation - 1] = true;
            events.close();
            if (generation === 1) rejectInitialContext(new Error("generation closed"));
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
      maxRecoveryDurationMs: 1_000,
      contextUpdateTimeoutMs: 500,
    });
    const stream = await reconnecting.open({
      sessionId: "stt_context_replay_abort_close" as SessionId,
      format: PCM16_16K_MONO,
      interimResults: true,
    });
    const controller = new AbortController();
    const contextUpdate = stream.updateAgentContext!("replay this context", {
      signal: controller.signal,
    });
    await initialContextStarted;
    const audioWrite = stream.sendAudio(audioChunk(1));
    await replayContextStarted;
    await replayAudioStarted;

    const close = stream.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    await expect(contextUpdate).rejects.toMatchObject({ code: "stt.context_update_failed" });
    releaseReplayAudio();

    await expect(audioWrite).resolves.toBeUndefined();
    await expect(close).resolves.toBeUndefined();
    expect(openCount).toBe(2);
    expect(closedGenerations).toEqual([true, true]);
    expect(getSttRecoveryControl(stream)?.state()).toBe("closed");
  });

  it("continues audio replay after a rejected reconnect context update", async () => {
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
            if (generation === 2) markReplayAudioSent();
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

    expect(openCount).toBe(2);
    expect(orders[1]).toEqual(["context:assistant reply", "audio"]);
    expect(contextErrors).toEqual(["stt.context_update_failed"]);
  });

  it("closes the active reconnect stream on abort while replay context is pending", async () => {
    let openCount = 0;
    const closeCounts = [0, 0];
    let markReconnectContextStarted!: () => void;
    const reconnectContextStarted = new Promise<void>((resolve) => {
      markReconnectContextStarted = resolve;
    });
    const capabilities = {
      streaming: { input: true, output: false, native: true },
      cancellation: { request: true, output: false, buffer: false, truncation: false },
      transports: ["websocket"],
      audio: { input: [PCM16_16K_MONO] },
    } satisfies ProviderCapabilities;
    const provider: SpeechToTextProvider = {
      name: "context-replay-abort-stt",
      kind: "stt",
      version: "0.1.0",
      capabilities,
      supportsSttAgentContext: () => true,
      async open(): Promise<SttStream> {
        openCount += 1;
        const generation = openCount;
        const events = new AsyncQueue<TranscriptEvent>();
        return {
          events,
          timestampOrigin: "generation",
          async sendAudio() {
            if (generation === 1) {
              throw providerError("stt.transport.write_failed", "restart", {
                provider: "context-replay-abort-stt",
                retriable: true,
              });
            }
          },
          async updateAgentContext(_context, options) {
            if (generation === 2) {
              markReconnectContextStarted();
              await new Promise<void>((resolve) => {
                const signal = options?.signal;
                if (signal?.aborted) resolve();
                else signal?.addEventListener("abort", () => resolve(), { once: true });
              });
            }
          },
          async commit() {},
          async close() {
            closeCounts[generation - 1] = (closeCounts[generation - 1] ?? 0) + 1;
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
      sessionId: "stt_context_abort_replay" as SessionId,
      format: PCM16_16K_MONO,
      interimResults: true,
    });
    const control = getSttRecoveryControl(stream);
    await stream.updateAgentContext!("confirmed context");
    await stream.sendAudio(audioChunk(1));
    await reconnectContextStarted;

    await control?.controller.abort();
    expect(control?.state()).toBe("closed");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));

    expect(openCount).toBe(2);
    expect(closeCounts).toEqual([1, 1]);
    expect(control?.state()).toBe("closed");
  });

  it("ignores a throwing context-error listener and continues audio after a replay rejection", async () => {
    let openCount = 0;
    let markReplayAudioSent!: () => void;
    let markAsyncListenerCalled!: () => void;
    const replayAudioSent = new Promise<void>((resolve) => {
      markReplayAudioSent = resolve;
    });
    const asyncListenerCalled = new Promise<void>((resolve) => {
      markAsyncListenerCalled = resolve;
    });
    const capabilities = {
      streaming: { input: true, output: false, native: true },
      cancellation: { request: true, output: false, buffer: false, truncation: false },
      transports: ["websocket"],
      audio: { input: [PCM16_16K_MONO] },
    } satisfies ProviderCapabilities;
    const provider: SpeechToTextProvider = {
      name: "throwing-context-listener-stt",
      kind: "stt",
      version: "0.1.0",
      capabilities,
      supportsSttAgentContext: () => true,
      async open(): Promise<SttStream> {
        openCount += 1;
        const generation = openCount;
        const events = new AsyncQueue<TranscriptEvent>();
        return {
          events,
          timestampOrigin: "generation",
          async sendAudio() {
            if (generation === 1) {
              throw providerError("stt.transport.write_failed", "restart", {
                provider: "throwing-context-listener-stt",
                retriable: true,
              });
            }
            markReplayAudioSent();
          },
          async updateAgentContext() {
            if (generation === 2) throw new Error("context rejected");
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
      sessionId: "stt_context_listener_throws" as SessionId,
      format: PCM16_16K_MONO,
      interimResults: true,
    });
    const control = getSttRecoveryControl(stream);
    const removeSyncListener = control?.subscribeContextUpdateError?.(() => {
      throw new Error("observer must not break recovery");
    });
    const removeAsyncListener = control?.subscribeContextUpdateError?.(async () => {
      markAsyncListenerCalled();
      throw new Error("async observer rejection must be handled");
    });
    await stream.updateAgentContext!("confirmed context");
    await stream.sendAudio(audioChunk(1));
    await replayAudioSent;
    await waitFor(() => getSttRecoveryControl(stream)?.state() === "healthy");
    await asyncListenerCalled;
    await stream.close();
    removeSyncListener?.();
    removeAsyncListener?.();

    expect(openCount).toBe(2);
  });

  it("continues replay audio after an unconfirmed reconnect context enqueue", async () => {
    let openCount = 0;
    const generations: Array<{ order: string[]; events: AsyncQueue<TranscriptEvent> }> = [];
    let markSecondGenerationAudioSent!: () => void;
    const secondGenerationAudioSent = new Promise<void>((resolve) => {
      markSecondGenerationAudioSent = resolve;
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
            if (generation === 2) markSecondGenerationAudioSent();
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
    await secondGenerationAudioSent;
    await waitFor(() => getSttRecoveryControl(stream)?.state() === "healthy");
    await stream.close();

    expect(openCount).toBe(2);
    expect(generations[1]?.order).toEqual(["context:latest assistant reply", "audio:1"]);
  });

  it("retires timed-out context updates before replay on a replacement stream", async () => {
    let openCount = 0;
    let markFirstContextStarted!: () => void;
    const firstContextStarted = new Promise<void>((resolve) => {
      markFirstContextStarted = resolve;
    });
    const contextsByGeneration: string[][] = [];
    const capabilities = {
      streaming: { input: true, output: false, native: true },
      cancellation: { request: true, output: false, buffer: false, truncation: false },
      transports: ["websocket"],
      audio: { input: [PCM16_16K_MONO] },
    } satisfies ProviderCapabilities;
    const provider: SpeechToTextProvider = {
      name: "timed-out-context-retire-stt",
      kind: "stt",
      version: "0.1.0",
      capabilities,
      supportsSttAgentContext: () => true,
      async open(): Promise<SttStream> {
        const generation = ++openCount;
        contextsByGeneration[generation - 1] = [];
        return {
          events: new AsyncQueue<TranscriptEvent>(),
          timestampOrigin: "generation",
          async sendAudio() {},
          updateAgentContext(context) {
            contextsByGeneration[generation - 1]?.push(context);
            if (generation === 1) {
              markFirstContextStarted();
              return new Promise<void>(() => undefined);
            }
            return Promise.resolve();
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
      contextUpdateTimeoutMs: 10,
    });
    const stream = await reconnecting.open({
      sessionId: "stt_context_timeout_retire" as SessionId,
      format: PCM16_16K_MONO,
      interimResults: true,
    });

    const update = stream.updateAgentContext!("caller-visible timeout");
    await firstContextStarted;
    await expect(update).rejects.toMatchObject({
      code: STT_ERROR_CODES.contextUpdateFailed,
      category: "timeout",
    });
    await waitFor(() => openCount === 2 && getSttRecoveryControl(stream)?.state() === "healthy");
    await stream.close();

    expect(contextsByGeneration).toEqual([["caller-visible timeout"], []]);
  });

  it("does not hold reconnect audio for a local context update", async () => {
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

    expect(audioPassedContext).toBe(true);
    expect(order).toEqual(["context:start", "audio:3", "context:done"]);
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

  it("does not count a canceled journal context against command capacity", async () => {
    let audioWrites = 0;
    let contextWrites = 0;
    const capabilities = {
      streaming: { input: true, output: false, native: true },
      cancellation: { request: true, output: false, buffer: false, truncation: false },
      transports: ["websocket"],
      audio: { input: [PCM16_16K_MONO] },
    } satisfies ProviderCapabilities;
    const provider: SpeechToTextProvider = {
      name: "canceled-context-capacity-stt",
      kind: "stt",
      version: "0.1.0",
      capabilities,
      supportsSttAgentContext: () => true,
      async open(): Promise<SttStream> {
        return {
          events: new AsyncQueue<TranscriptEvent>(),
          timestampOrigin: "generation",
          async sendAudio() {
            audioWrites += 1;
          },
          async updateAgentContext() {
            contextWrites += 1;
          },
          async commit() {},
          async close() {},
        };
      },
    };
    const reconnecting = withSttReconnect(provider, {
      jitter: false,
      maxBufferedCommands: 1,
    });
    const stream = await reconnecting.open({
      sessionId: "stt_context_canceled_capacity" as SessionId,
      format: PCM16_16K_MONO,
      interimResults: true,
    });
    const controller = new AbortController();
    const update = stream.updateAgentContext!("canceled", { signal: controller.signal });
    controller.abort();

    await expect(update).rejects.toMatchObject({ code: "stt.context_update_failed" });
    await stream.sendAudio(audioChunk(1));
    await waitFor(() => audioWrites === 1);
    await stream.close();

    expect(contextWrites).toBe(0);
  });

  it("drops failed context history instead of replaying it after later reconnects", async () => {
    let openCount = 0;
    let replayAudioSent!: () => void;
    const replayAudio = new Promise<void>((resolve) => {
      replayAudioSent = resolve;
    });
    const contextCalls: Array<{ generation: number; context: string }> = [];
    const capabilities = {
      streaming: { input: true, output: false, native: true },
      cancellation: { request: true, output: false, buffer: false, truncation: false },
      transports: ["websocket"],
      audio: { input: [PCM16_16K_MONO] },
    } satisfies ProviderCapabilities;
    const provider: SpeechToTextProvider = {
      name: "failed-context-history-stt",
      kind: "stt",
      version: "0.1.0",
      capabilities,
      supportsSttAgentContext: () => true,
      async open(): Promise<SttStream> {
        openCount += 1;
        const generation = openCount;
        return {
          events: new AsyncQueue<TranscriptEvent>(),
          timestampOrigin: "generation",
          async sendAudio() {
            if (generation === 1) {
              throw providerError("stt.transport.write_failed", "restart", {
                provider: "failed-context-history-stt",
                retriable: true,
              });
            }
            replayAudioSent();
          },
          async updateAgentContext(context) {
            contextCalls.push({ generation, context });
            if (generation === 1) throw new Error("definite rejection");
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
      sessionId: "stt_context_failed_history" as SessionId,
      format: PCM16_16K_MONO,
      interimResults: true,
    });
    for (let version = 0; version < 64; version += 1) {
      await expect(stream.updateAgentContext!(`failed ${version}`)).rejects.toMatchObject({
        code: "stt.context_update_failed",
        retriable: false,
      });
    }
    await stream.sendAudio(audioChunk(1));
    await replayAudio;
    await waitFor(() => getSttRecoveryControl(stream)?.state() === "healthy");
    await stream.close();

    expect(openCount).toBe(2);
    expect(contextCalls).toHaveLength(64);
    expect(contextCalls.every(({ generation }) => generation === 1)).toBe(true);
  });

  it.each(
    Array.from(
      { length: 32 },
      (_value, index) => (0x5eed1234 + Math.imul(index, 0x9e3779b9)) >>> 0,
    ),
  )(
    "settles seeded context success, rejection, timeout, abort, and audio traffic (seed %i)",
    async (initialSeed) => {
      let openCount = 0;
      let failFirstAudio = true;
      const closedGenerations: boolean[] = [];
      const contextCalls: Array<{ generation: number; context: string }> = [];
      const audioCalls: Array<{ generation: number; value: number }> = [];
      const capabilities = {
        streaming: { input: true, output: false, native: true },
        cancellation: { request: true, output: false, buffer: false, truncation: false },
        transports: ["websocket"],
        audio: { input: [PCM16_16K_MONO] },
      } satisfies ProviderCapabilities;
      const provider: SpeechToTextProvider = {
        name: "seeded-context-audio-stt",
        kind: "stt",
        version: "0.1.0",
        capabilities,
        supportsSttAgentContext: () => true,
        async open(): Promise<SttStream> {
          openCount += 1;
          const generation = openCount;
          closedGenerations[generation - 1] = false;
          return {
            events: new AsyncQueue<TranscriptEvent>(),
            timestampOrigin: "generation",
            async sendAudio(chunk) {
              const value = chunk.audio.bytes[0] ?? 0;
              if (generation === 1 && failFirstAudio) {
                failFirstAudio = false;
                throw providerError("stt.transport.write_failed", "seeded restart", {
                  provider: "seeded-context-audio-stt",
                  retriable: true,
                });
              }
              audioCalls.push({ generation, value });
            },
            async updateAgentContext(context) {
              contextCalls.push({ generation, context });
              if (context.includes("-hang")) return new Promise<void>(() => {});
              if (context.includes("reject")) throw new Error("seeded definite rejection");
            },
            async commit() {},
            async close() {
              closedGenerations[generation - 1] = true;
            },
          };
        },
      };
      const reconnecting = withSttReconnect(provider, {
        jitter: false,
        initialBackoffMs: 0,
        maxBackoffMs: 0,
        stableUptimeMs: 1,
        maxAttempts: 16,
        maxRecoveryDurationMs: 500,
        contextUpdateTimeoutMs: 10,
      });
      const stream = await reconnecting.open({
        sessionId: "stt_context_seeded_mix" as SessionId,
        format: PCM16_16K_MONO,
        interimResults: true,
      });
      await stream.updateAgentContext!("seed-base");
      const contextOutcomes: Promise<unknown>[] = [];
      const audioAdmissions: Promise<void>[] = [stream.sendAudio(audioChunk(0))];
      let seed = initialSeed >>> 0;
      const nextRandom = (): number => {
        seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
        return seed;
      };
      let expectedAudioCount = 1;
      for (let index = 0; index < 36; index += 1) {
        const random = nextRandom();
        if (random % 3 === 0) {
          const suffix =
            random % 13 === 0
              ? "-abort"
              : random % 11 === 0
                ? "-hang"
                : random % 7 === 0
                  ? "-reject"
                  : "";
          const context = `seed-${index}${suffix}`;
          if (suffix === "-abort") {
            const controller = new AbortController();
            const outcome = stream.updateAgentContext!(context, { signal: controller.signal }).then(
              () => undefined,
              (error: unknown) => error,
            );
            controller.abort();
            contextOutcomes.push(outcome);
            continue;
          }
          contextOutcomes.push(
            stream.updateAgentContext!(context).then(
              () => undefined,
              (error: unknown) => error,
            ),
          );
        } else {
          expectedAudioCount += 1;
          audioAdmissions.push(stream.sendAudio(audioChunk(index + 1)));
        }
      }
      await Promise.all([...contextOutcomes, ...audioAdmissions]);
      await waitFor(() => getSttRecoveryControl(stream)?.state() === "healthy");
      const lastGeneration = openCount;
      await waitFor(
        () =>
          audioCalls.filter(({ generation }) => generation === lastGeneration).length >=
          expectedAudioCount,
      );
      const openedAtClose = openCount;
      await expect(stream.close()).resolves.toBeUndefined();
      await expect(stream.sendAudio(audioChunk(99))).rejects.toMatchObject({
        code: "stt.reconnect.closed",
      });

      expect(openCount).toBeGreaterThanOrEqual(2);
      expect(openCount).toBe(openedAtClose);
      expect(closedGenerations).toHaveLength(openCount);
      expect(closedGenerations.every(Boolean)).toBe(true);
      expect(contextOutcomes).toHaveLength(37 - expectedAudioCount);
      expect(audioCalls.filter(({ generation }) => generation === lastGeneration)).toHaveLength(
        expectedAudioCount,
      );
      expect(contextCalls.some(({ generation }) => generation === lastGeneration)).toBe(true);
      for (let generation = 1; generation <= lastGeneration; generation += 1) {
        const contextVersions = contextCalls
          .filter((call) => call.generation === generation)
          .map(({ context }) => /^seed-(\d+)/u.exec(context)?.[1])
          .filter((version): version is string => version !== undefined)
          .map(Number);
        expect(contextVersions).toEqual([...contextVersions].sort((left, right) => left - right));
      }
    },
  );

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

  it.each(["cancellation", "definite rejection"] as const)(
    "replays the last accepted context when reconnect context update has %s",
    async (failureMode) => {
      let openCount = 0;
      const generations: Array<{ events: AsyncQueue<TranscriptEvent>; order: string[] }> = [];
      let markSecondOpenStarted!: () => void;
      const secondOpenStarted = new Promise<void>((resolve) => {
        markSecondOpenStarted = resolve;
      });
      let releaseSecondOpen!: () => void;
      const secondOpenGate = new Promise<void>((resolve) => {
        releaseSecondOpen = resolve;
      });
      let markFailedContextStarted!: () => void;
      const failedContextStarted = new Promise<void>((resolve) => {
        markFailedContextStarted = resolve;
      });
      let markRestoredContextStarted!: () => void;
      const restoredContextStarted = new Promise<void>((resolve) => {
        markRestoredContextStarted = resolve;
      });
      let markCancellationObserved!: () => void;
      const cancellationObserved = new Promise<void>((resolve) => {
        markCancellationObserved = resolve;
      });
      let markLateCancelledContextApplied!: () => void;
      const lateCancelledContextApplied = new Promise<void>((resolve) => {
        markLateCancelledContextApplied = resolve;
      });
      let releaseLateCancelledContext!: () => void;
      const lateCancelledContextGate = new Promise<void>((resolve) => {
        releaseLateCancelledContext = resolve;
      });
      let releaseRestoredContext!: () => void;
      const restoredContextGate = new Promise<void>((resolve) => {
        releaseRestoredContext = resolve;
      });
      const capabilities = {
        streaming: { input: true, output: false, native: true },
        cancellation: { request: true, output: false, buffer: false, truncation: false },
        transports: ["websocket"],
        audio: { input: [PCM16_16K_MONO] },
      } satisfies ProviderCapabilities;
      const provider: SpeechToTextProvider = {
        name: "reconnect-canceled-context-restore-stt",
        kind: "stt",
        version: "0.1.0",
        capabilities,
        supportsSttAgentContext: () => true,
        async open(): Promise<SttStream> {
          openCount += 1;
          const generation = openCount;
          if (generation === 2) {
            markSecondOpenStarted();
            await secondOpenGate;
          }
          const events = new AsyncQueue<TranscriptEvent>();
          const order: string[] = [];
          generations.push({ events, order });
          return {
            events,
            timestampOrigin: "generation",
            async sendAudio(chunk) {
              const byte = chunk.audio.bytes[0] ?? 0;
              order.push(`audio:${generation}:${byte}`);
              if (generation === 1) {
                throw providerError("stt.transport.write_failed", "restart after audio failure", {
                  provider: "reconnect-canceled-context-restore-stt",
                  retriable: true,
                });
              }
            },
            async updateAgentContext(context, options) {
              order.push(`context-start:${generation}:${context}`);
              if (generation === 2 && context === "failed context") {
                markFailedContextStarted();
                if (failureMode === "cancellation") {
                  await new Promise<void>((resolve) => {
                    const signal = options?.signal;
                    if (signal?.aborted) {
                      order.push("abort-observed");
                      markCancellationObserved();
                      resolve();
                      return;
                    }
                    signal?.addEventListener(
                      "abort",
                      () => {
                        order.push("abort-observed");
                        markCancellationObserved();
                        resolve();
                      },
                      { once: true },
                    );
                  });
                  await lateCancelledContextGate;
                  order.push("late-context-applied:2:failed context");
                  markLateCancelledContextApplied();
                  return;
                }
                order.push("definite-rejection");
                throw providerError(
                  "stt.context_update_failed",
                  "reconnect context update was rejected",
                  { provider: "reconnect-canceled-context-restore-stt", retriable: false },
                );
              }
              if (generation === 2 && context === "last accepted context") {
                markRestoredContextStarted();
                await restoredContextGate;
              }
              order.push(`context-accepted:${generation}:${context}`);
            },
            async commit() {},
            async close() {
              events.close();
            },
          };
        },
      };
      const stream = await withSttReconnect(provider, {
        jitter: false,
        initialBackoffMs: 0,
        maxBackoffMs: 0,
        stableUptimeMs: 1,
        maxAttempts: 2,
        maxRecoveryDurationMs: 1_000,
      }).open({
        sessionId: "stt_context_restore_after_cancel" as SessionId,
        format: PCM16_16K_MONO,
        interimResults: true,
      });
      await stream.updateAgentContext!("last accepted context");
      await stream.sendAudio(audioChunk(1));
      await secondOpenStarted;

      const controller = new AbortController();
      const failedUpdate = stream.updateAgentContext!(
        "failed context",
        failureMode === "cancellation" ? { signal: controller.signal } : undefined,
      );
      const failedOutcome = expect(failedUpdate).rejects.toMatchObject({
        code: "stt.context_update_failed",
        retriable: failureMode === "cancellation",
      });
      releaseSecondOpen();
      await failedContextStarted;
      if (failureMode === "cancellation") {
        await waitFor(() => generations[1]?.order.includes("audio:2:1") === true);
        expect(generations[1]?.order).not.toContain("context-start:2:last accepted context");
        controller.abort();
        await cancellationObserved;
      } else {
        await restoredContextStarted;
        await waitFor(() => generations[1]?.order.includes("audio:2:1") === true);
        expect(generations[1]?.order.indexOf("definite-rejection")).toBeLessThan(
          generations[1]?.order.indexOf("context-start:2:last accepted context") ?? -1,
        );
        expect(generations[1]?.order).not.toContain("context-accepted:2:last accepted context");
        releaseRestoredContext();
        await waitFor(
          () => generations[1]?.order.includes("context-accepted:2:last accepted context") === true,
        );
      }
      await failedOutcome;
      await waitFor(() => getSttRecoveryControl(stream)?.state() === "healthy");
      if (failureMode === "cancellation") {
        expect(openCount).toBe(3);
        await waitFor(
          () =>
            generations[2]?.order.includes("context-accepted:3:last accepted context") === true &&
            generations[2]?.order.includes("audio:3:1") === true,
        );
        const generationThreeOrder = generations[2]?.order ?? [];
        expect(generationThreeOrder.indexOf("context-start:3:last accepted context")).toBeLessThan(
          generationThreeOrder.indexOf("audio:3:1"),
        );
        expect(generationThreeOrder).not.toContain("context-start:3:failed context");
        releaseLateCancelledContext();
        await lateCancelledContextApplied;
        expect(generationThreeOrder).not.toContain("late-context-applied:2:failed context");
      }
      await stream.close();

      expect(generations[0]?.order).toEqual([
        "context-start:1:last accepted context",
        "context-accepted:1:last accepted context",
        "audio:1:1",
      ]);
      expect(generations[1]?.order).toContain(
        failureMode === "cancellation" ? "abort-observed" : "definite-rejection",
      );
      const restoredGeneration = failureMode === "cancellation" ? 3 : 2;
      const restoredOrder = generations[restoredGeneration - 1]?.order ?? [];
      expect(restoredOrder).toContain(
        `context-accepted:${restoredGeneration}:last accepted context`,
      );
      const restoredContextIndex = restoredOrder.indexOf(
        `context-start:${restoredGeneration}:last accepted context`,
      );
      const replayAudioIndex = restoredOrder.indexOf(`audio:${restoredGeneration}:1`);
      expect(restoredContextIndex).toBeGreaterThanOrEqual(0);
      expect(replayAudioIndex).toBeGreaterThanOrEqual(0);
      if (failureMode === "cancellation") {
        expect(restoredContextIndex).toBeLessThan(replayAudioIndex!);
      } else {
        expect(restoredOrder.indexOf("definite-rejection")).toBeLessThan(restoredContextIndex);
      }
      expect(openCount).toBe(failureMode === "cancellation" ? 3 : 2);
    },
  );

  it("fences a reconnect stream when an older context replay times out after a newer update", async () => {
    let openCount = 0;
    const generations: Array<{ events: AsyncQueue<TranscriptEvent>; order: string[] }> = [];
    let markOlderReplayStarted!: () => void;
    const olderReplayStarted = new Promise<void>((resolve) => {
      markOlderReplayStarted = resolve;
    });
    let releaseOlderReplay!: () => void;
    const olderReplayGate = new Promise<void>((resolve) => {
      releaseOlderReplay = resolve;
    });
    let markLatestContextApplied!: () => void;
    const latestContextApplied = new Promise<void>((resolve) => {
      markLatestContextApplied = resolve;
    });
    let markOlderReplayFailed!: () => void;
    const olderReplayFailed = new Promise<void>((resolve) => {
      markOlderReplayFailed = resolve;
    });
    const capabilities = {
      streaming: { input: true, output: false, native: true },
      cancellation: { request: true, output: false, buffer: false, truncation: false },
      transports: ["websocket"],
      audio: { input: [PCM16_16K_MONO] },
    } satisfies ProviderCapabilities;
    const provider: SpeechToTextProvider = {
      name: "late-context-replay-stt",
      kind: "stt",
      version: "0.1.0",
      capabilities,
      supportsSttAgentContext: () => true,
      async open(): Promise<SttStream> {
        openCount += 1;
        const generation = openCount;
        const events = new AsyncQueue<TranscriptEvent>();
        const order: string[] = [];
        generations.push({ events, order });
        return {
          events,
          timestampOrigin: "generation",
          async sendAudio() {
            if (generation === 1) {
              throw providerError("stt.transport.write_failed", "restart after audio", {
                provider: "late-context-replay-stt",
                retriable: true,
              });
            }
          },
          async updateAgentContext(context) {
            order.push(`context-start:${context}`);
            if (generation === 2 && context === "accepted context") {
              markOlderReplayStarted();
              await olderReplayGate;
              order.push("context-applied-late:accepted context");
              return;
            }
            order.push(`context-applied:${context}`);
            if (generation === 3 && context === "latest context") {
              markLatestContextApplied();
            }
          },
          async commit() {},
          async close() {
            events.close();
          },
        };
      },
    };
    const stream = await withSttReconnect(provider, {
      jitter: false,
      initialBackoffMs: 0,
      maxBackoffMs: 0,
      stableUptimeMs: 1,
      maxAttempts: 2,
      maxRecoveryDurationMs: 1_000,
      sendTimeoutMs: 20,
    }).open({
      sessionId: "stt_context_late_older_replay" as SessionId,
      format: PCM16_16K_MONO,
      interimResults: true,
    });
    const removeErrorListener = getSttRecoveryControl(stream)?.subscribeContextUpdateError?.(() => {
      markOlderReplayFailed();
    });

    await stream.updateAgentContext!("accepted context");
    await stream.sendAudio(audioChunk(1));
    await olderReplayStarted;
    await olderReplayFailed;
    expect(openCount).toBe(2);
    const latestUpdate = stream.updateAgentContext!("latest context");
    await waitFor(() => openCount === 3);
    await latestContextApplied;
    await latestUpdate;
    await waitFor(() => openCount === 3);

    releaseOlderReplay();
    await waitFor(
      () => generations[1]?.order.includes("context-applied-late:accepted context") === true,
    );
    await stream.close();
    removeErrorListener?.();

    expect(generations[1]?.order).toEqual([
      "context-start:accepted context",
      "context-applied-late:accepted context",
    ]);
    expect(generations[2]?.order).toEqual([
      "context-start:latest context",
      "context-applied:latest context",
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
