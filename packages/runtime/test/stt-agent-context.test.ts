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
  it("continues sending caller audio while a context update is pending", async () => {
    const order: string[] = [];
    let markContextStarted!: () => void;
    const contextStarted = new Promise<void>((resolve) => {
      markContextStarted = resolve;
    });
    let releaseContext!: () => void;
    const contextGate = new Promise<void>((resolve) => {
      releaseContext = resolve;
    });
    const stream: SttStream & { updateAgentContext(context: string): Promise<void> } = {
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

  it("sends a replacement context after a pending write without holding caller audio", async () => {
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
    await waitFor(() => order.includes("audio:5"));
    const audioPassedPendingContext = order.includes("audio:5");
    releaseFirstContext();
    const [, alignedPrefixError] = await Promise.all([fullContext, alignedPrefixOutcome]);
    await controller.drain();

    expect(audioPassedPendingContext).toBe(true);
    expect(alignedPrefixError).toBeUndefined();
    expect(order).toEqual(["context:full response", "context:heard prefix", "audio:5"]);
  });

  it("keeps the STT command stream usable when a context update fails", async () => {
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
    });
    await controller.admitAudio(audioChunk(7));
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

  it("does not hold replayed caller audio on reconnect context acknowledgement", async () => {
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

    expect(replayedBeforeContextAcknowledgement).toBe(true);
    expect(generations[1]?.order).toEqual(["context:newest context", "audio:1", "context:done"]);
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
            markReplayAudioSent();
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
    const firstAfterBootstrap = await Promise.race([
      alignedReplayContextStarted.then(() => "context" as const),
      replayAudioSent.then(() => "audio" as const),
    ]);
    releaseFirstReplayContext();
    await alignedReplayContextStarted;
    const latestSettledByPriorWrite = latestSettled;
    releaseAlignedReplayContext();
    const [latestUpdateError, admittedUpdateError] = await Promise.all([
      latestOutcome,
      admittedOutcome,
    ]);
    await waitFor(() => generations[1]?.order.includes("audio:1") === true);
    await stream.close();

    expect(firstAfterBootstrap).toBe("context");
    expect(latestSettledByPriorWrite).toBe(false);
    expect(latestUpdateError).toBeUndefined();
    expect(admittedUpdateError).toBeUndefined();
    expect(generations[1]?.order).toEqual([
      "context:latest queued",
      "context:newest queued",
      "audio:1",
    ]);
  });

  it("reports a rejected live context update without stopping audio", async () => {
    const order: string[] = [];
    let openCount = 0;
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
        const events = new AsyncQueue<TranscriptEvent>();
        return {
          events,
          timestampOrigin: "generation",
          async sendAudio(chunk) {
            order.push(`audio:${chunk.audio.bytes[0] ?? 0}`);
          },
          async updateAgentContext(context) {
            order.push(`context:${context}`);
            throw new Error("provider rejected context");
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

    const contextUpdate = commands.updateAgentContext("latest assistant reply");
    await stream.sendAudio(audioChunk(9));
    await expect(contextUpdate).rejects.toMatchObject({ code: "stt.context_update_failed" });
    await waitFor(() => order.includes("audio:9"));
    await stream.close();

    expect(order).toEqual(["context:latest assistant reply", "audio:9"]);
    expect(openCount).toBe(1);
  });

  it("bounds overlapping context writes without stopping audio", async () => {
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
      maxAttempts: 2,
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
    await waitFor(() => order.includes("audio:4"));
    await stream.close();

    expect(openCount).toBe(1);
    expect(contextWrites).toBe(2);
    expect(order).toEqual(["audio:4"]);
  });

  it.each(["rejected", "timed out"] as const)(
    "reports a %s reconnect context failure without holding replayed audio",
    async (failureMode) => {
      let openCount = 0;
      const contextErrors: string[] = [];
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
              markReplayAudioSent();
            },
            async updateAgentContext() {
              if (generation !== 2) return;
              if (failureMode === "rejected") throw new Error("context update rejected");
              await new Promise<void>(() => undefined);
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
      expect(contextErrors).toEqual(["stt.context_update_failed"]);
    },
  );

  it("continues sending reconnect audio while a context update is pending", async () => {
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
