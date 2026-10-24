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

import { withSttReconnect } from "../src/resilient-stt.js";
import { SerialSttCommandController } from "../src/stt-command-controller.js";
import { boundSttAgentContext } from "../src/stt-agent-context.js";
import { TS } from "./harness.js";

interface ContextCommandController extends SerialSttCommandController {
  admitAgentContext(context: string): Promise<void>;
}

describe("STT agent context commands", () => {
  it("queues caller audio behind local context acceptance without blocking admission", async () => {
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

    expect(audioPassedContext).toBe(false);
    expect(order).toEqual(["context:start", "context:done", "audio:1"]);
  });

  it("fences the STT command stream when a context update fails", async () => {
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

    await expect(controller.admitAgentContext("private assistant reply")).rejects.toBeDefined();
    await expect(controller.admitAudio(audioChunk(7))).rejects.toBeDefined();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(failed).toBe(true);
    expect(audioValues).toEqual([]);
    await controller.abort();
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

  it("reapplies the latest context before replaying audio after reconnect", async () => {
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
    await newestContext;
    await waitFor(() => generations[1]?.order.length === 2);

    expect(generations[1]?.order).toEqual(["context:newest context", "audio:1"]);
    await stream.close();
  });

  it("recovers before sending audio when a context update is rejected", async () => {
    const generations: Array<{ readonly order: string[]; readonly events: AsyncQueue<TranscriptEvent> }> = [];
    let openCount = 0;
    let markContextStarted!: () => void;
    const contextStarted = new Promise<void>((resolve) => {
      markContextStarted = resolve;
    });
    let rejectContext!: (error: unknown) => void;
    const contextGate = new Promise<void>((_, reject) => {
      rejectContext = reject;
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
        const order: string[] = [];
        const events = new AsyncQueue<TranscriptEvent>();
        generations.push({ order, events });
        return {
          events,
          timestampOrigin: "generation",
          async sendAudio(chunk) {
            order.push(`audio:${chunk.audio.bytes[0] ?? 0}`);
          },
          async updateAgentContext(context) {
            order.push(`context:${context}`);
            if (generation === 1) {
              markContextStarted();
              await contextGate;
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

    const contextUpdate = commands.updateAgentContext("latest assistant reply");
    await contextStarted;
    await stream.sendAudio(audioChunk(9));
    rejectContext(new Error("local enqueue failed"));
    await contextUpdate;
    await waitFor(() => generations[1]?.order.includes("audio:9") === true);
    await stream.close();

    expect(generations[0]?.order).toEqual(["context:latest assistant reply"]);
    expect(generations[1]?.order).toEqual([
      "context:latest assistant reply",
      "audio:9",
    ]);
  });

  it("does not create overlapping provider writes after an unconfirmed context timeout", async () => {
    let openCount = 0;
    let contextWrites = 0;
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
          async sendAudio() {},
          updateAgentContext() {
            contextWrites += 1;
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

    await expect(commands.updateAgentContext("assistant reply")).rejects.toMatchObject({
      code: "stt.reconnect.recovery_exhausted",
      cause: { code: "stt.context_update_failed" },
    });
    await stream.close().catch(() => undefined);

    expect(openCount).toBeGreaterThan(1);
    expect(contextWrites).toBe(1);
  });

  it.each(["rejected", "timed out"] as const)(
    "closes a reconnect stream when carrying agent context is %s",
    async (failureMode) => {
      let openCount = 0;
      let secondStreamCloseCount = 0;
      let secondStreamCloseCountAtThirdOpen = -1;
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
          if (generation === 3) {
            secondStreamCloseCountAtThirdOpen = secondStreamCloseCount;
          }
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
            },
            async updateAgentContext() {
              if (generation !== 2) return;
              if (failureMode === "rejected") throw new Error("context update rejected");
              await new Promise<void>(() => undefined);
            },
            async commit() {},
            async close() {
              if (generation === 2) secondStreamCloseCount += 1;
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

      await expect(stream.updateAgentContext!("assistant reply")).resolves.toBeUndefined();
      await expect(stream.sendAudio(audioChunk(1))).resolves.toBeUndefined();
      await waitFor(() => openCount === 3);
      if (failureMode === "timed out") {
        await expect(stream.close()).rejects.toMatchObject({
          code: "stt.reconnect.recovery_exhausted",
        });
      } else {
        await stream.close();
      }

      expect(secondStreamCloseCountAtThirdOpen).toBe(1);
    },
  );

  it("queues reconnect audio behind local context acceptance without blocking admission", async () => {
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
