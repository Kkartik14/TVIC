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
  it("continues sending caller audio while a context update is still pending", async () => {
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

  it("keeps the STT command stream usable when a context update fails", async () => {
    const audioValues: number[] = [];
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

    await expect(controller.admitAgentContext("private assistant reply")).rejects.toBeDefined();
    await controller.admitAudio(audioChunk(7));
    await controller.drain();

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
    releaseSecondOpen();
    await latestContext;
    await waitFor(() => generations[1]?.order.length === 2);

    expect(generations[1]?.order).toEqual(["context:latest context", "audio:1"]);
    await stream.close();
  });

  it("does not wait for an update acknowledgement before sending queued reconnect audio", async () => {
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
