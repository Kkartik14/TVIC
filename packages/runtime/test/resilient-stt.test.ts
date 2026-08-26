import { describe, expect, it } from "vitest";

import {
  PCM16_16K_MONO,
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

const CAPABILITIES = {
  streaming: { input: true, output: false, native: true },
  cancellation: { request: true, output: false, buffer: false, truncation: false },
  transports: ["websocket"],
  audio: { input: [PCM16_16K_MONO] },
} satisfies ProviderCapabilities;

describe("withSttReconnect", () => {
  it("replays ordered audio and commit barriers after a retriable generation failure", async () => {
    const fake = makeProvider();
    const provider = withSttReconnect(fake.provider, {
      jitter: false,
      initialBackoffMs: 0,
      maxBackoffMs: 0,
      stableUptimeMs: 5,
      maxAttempts: 2,
    });
    const stream = await provider.open(openRequest());
    const first = fake.streams[0]!;

    await stream.sendAudio(audioChunk(1));
    const commit = stream.commit();
    await stream.sendAudio(audioChunk(2));
    await commit;

    first.failNextAudio = true;
    await stream.sendAudio(audioChunk(3));
    await waitFor(() => fake.streams.length === 2);
    const second = fake.streams[1]!;
    await waitFor(() => second.order.length === 4);

    expect(second.order).toEqual(["audio:1", "commit", "audio:2", "audio:3"]);
    expect(getSttRecoveryControl(stream)?.state()).toBe("probationary");

    const iterator = stream.events[Symbol.asyncIterator]();
    second.events.push(transcript("stt.final", "recovered", 0, 20));
    second.events.push(endpointTranscript());
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: expect.objectContaining({ type: "stt.final", text: "recovered", sequence: 1 }),
    });
    await waitFor(() => getSttRecoveryControl(stream)?.state() === "healthy");
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: expect.objectContaining({ type: "stt.endpoint", sequence: 2 }),
    });
    await stream.close();
  });

  it("retains the latest settled barrier for future post-commit replay", async () => {
    const fake = makeProvider();
    const provider = withSttReconnect(fake.provider, {
      jitter: false,
      initialBackoffMs: 0,
      maxBackoffMs: 0,
      uncertainWindowMs: 0,
    });
    const stream = await provider.open(openRequest());
    const first = fake.streams[0]!;

    await stream.sendAudio(audioChunk(1));
    await waitFor(() => first.order.length === 1);
    await stream.commit();
    await waitFor(() => first.order.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 10));

    first.failNextAudio = true;
    await stream.sendAudio(audioChunk(2));
    await waitFor(() => fake.streams.length === 2);
    await waitFor(() => fake.streams[1]?.order.length === 2);

    expect(fake.streams[1]?.order).toEqual(["commit", "audio:2"]);
    await stream.close();
  });

  it("fences stale generation events and rejects an unsupported timestamp origin", async () => {
    const fake = makeProvider();
    const provider = withSttReconnect(fake.provider, {
      jitter: false,
      initialBackoffMs: 0,
      maxBackoffMs: 0,
      stableUptimeMs: 5,
      maxAttempts: 1,
    });
    const stream = await provider.open(openRequest());
    const first = fake.streams[0]!;
    const iterator = stream.events[Symbol.asyncIterator]();
    first.failNextAudio = true;
    await stream.sendAudio(audioChunk(1));
    await waitFor(() => fake.streams.length === 2);
    const second = fake.streams[1]!;

    first.events.push(transcript("stt.final", "stale", 0, 10));
    second.events.push(transcript("stt.final", "fresh", 0, 10));
    await expect(iterator.next()).resolves.toMatchObject({
      value: expect.objectContaining({ text: "fresh" }),
    });
    await stream.close();

    const unsupported = makeProvider({ missingTimestampOrigin: true });
    const reconnecting = withSttReconnect(unsupported.provider, {
      initialBackoffMs: 0,
      maxBackoffMs: 0,
    });
    await expect(reconnecting.open(openRequest())).rejects.toMatchObject({
      code: "stt.reconnect.timestamp_origin_unsupported",
    });
  });

  it("normalizes generation-relative transcript offsets onto the session timeline", async () => {
    const fake = makeProvider();
    const provider = withSttReconnect(fake.provider, {
      jitter: false,
      initialBackoffMs: 0,
      maxBackoffMs: 0,
      uncertainWindowMs: 0,
      stableUptimeMs: 5,
    });
    const stream = await provider.open(openRequest());
    const first = fake.streams[0]!;

    await stream.sendAudio(audioChunk(1));
    await waitFor(() => first.order.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await stream.sendAudio(audioChunk(2));
    await waitFor(() => first.order.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 25));

    first.failNextAudio = true;
    await stream.sendAudio(audioChunk(3));
    await waitFor(() => fake.streams.length === 2);

    const second = fake.streams[1]!;
    const iterator = stream.events[Symbol.asyncIterator]();
    second.events.push(transcript("stt.final", "offset", 0, 1));

    await expect(iterator.next()).resolves.toMatchObject({
      value: expect.objectContaining({ audioStartMs: 2, audioEndMs: 3 }),
    });
    await stream.close();
  });

  it("fails closed on journal overflow and closes during recovery without a late open", async () => {
    const fake = makeProvider();
    const provider = withSttReconnect(fake.provider, {
      jitter: false,
      initialBackoffMs: 20,
      maxBackoffMs: 20,
      maxBufferedBytes: 4,
      maxAttempts: 2,
    });
    const stream = await provider.open(openRequest());
    const first = fake.streams[0]!;
    await expect(stream.sendAudio(audioChunk(1, 8))).rejects.toMatchObject({
      code: "stt.reconnect.buffer_overflow",
    });
    await expect(stream.sendAudio(audioChunk(1))).rejects.toMatchObject({
      code: "stt.reconnect.closed",
    });

    const secondFake = makeProvider({ failInitialAudio: true });
    const secondProvider = withSttReconnect(secondFake.provider, {
      jitter: false,
      initialBackoffMs: 50,
      maxBackoffMs: 50,
      maxAttempts: 2,
    });
    const secondStream = await secondProvider.open(openRequest());
    await secondStream.sendAudio(audioChunk(1));
    await waitFor(() => getSttRecoveryControl(secondStream)?.state() === "recovering");
    await getSttRecoveryControl(secondStream)?.controller.abort();
    await secondStream.close();
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(secondFake.streams).toHaveLength(1);
    await first.stream.close();
  });

  it("does not nest identical policy wrappers", () => {
    const fake = makeProvider();
    const options = { jitter: false, initialBackoffMs: 0, maxBackoffMs: 0 } as const;
    const first = withSttReconnect(fake.provider, options);
    expect(withSttReconnect(first, options)).toBe(first);
    expect(() => withSttReconnect(first, { ...options, maxAttempts: 1 })).toThrow(
      "different reconnect policy",
    );
  });

  it("fails immediately on a permanent reconnect-open error", async () => {
    const fake = makeProvider({ failReconnectOpen: "auth" });
    const provider = withSttReconnect(fake.provider, {
      jitter: false,
      initialBackoffMs: 0,
      maxBackoffMs: 0,
      maxAttempts: 3,
    });
    const stream = await provider.open(openRequest());
    const first = fake.streams[0]!;
    const iterator = stream.events[Symbol.asyncIterator]();
    first.failNextAudio = true;
    await stream.sendAudio(audioChunk(1));

    await expect(iterator.next()).rejects.toMatchObject({
      code: "stt.provider.auth_failed",
      retriable: false,
    });
    expect(fake.streams).toHaveLength(1);
    await stream.close();
  });

  it("honors the aggregate recovery deadline across repeated transient opens", async () => {
    const fake = makeProvider({ failReconnectOpen: "transient" });
    const provider = withSttReconnect(fake.provider, {
      jitter: false,
      initialBackoffMs: 5,
      maxBackoffMs: 5,
      connectTimeoutMs: 10,
      maxRecoveryDurationMs: 20,
      stableUptimeMs: 5,
      commitTimeoutMs: 5,
      maxAttempts: 10,
    });
    const stream = await provider.open(openRequest());
    const first = fake.streams[0]!;
    const iterator = stream.events[Symbol.asyncIterator]();
    first.failNextAudio = true;
    await stream.sendAudio(audioChunk(1));

    await expect(iterator.next()).rejects.toMatchObject({
      code: "stt.reconnect.recovery_exhausted",
      retriable: false,
    });
    expect(fake.openCalls).toBeGreaterThan(1);
    await stream.close();
  });

  it("does not enter healthy state until the replay prefix has dispatched", async () => {
    const fake = makeProvider({ blockReconnectAudio: true });
    const provider = withSttReconnect(fake.provider, {
      jitter: false,
      initialBackoffMs: 0,
      maxBackoffMs: 0,
      connectTimeoutMs: 20,
      commitTimeoutMs: 20,
      stableUptimeMs: 5,
      maxRecoveryDurationMs: 100,
    });
    const stream = await provider.open(openRequest());
    const first = fake.streams[0]!;
    first.failNextAudio = true;
    await stream.sendAudio(audioChunk(1));

    await waitFor(() => fake.streams.length === 2);
    await waitFor(() => getSttRecoveryControl(stream)?.state() === "probationary");
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(getSttRecoveryControl(stream)?.state()).toBe("probationary");

    fake.releaseReconnectAudio();
    await waitFor(() => getSttRecoveryControl(stream)?.state() === "healthy");
    await stream.close();
  });

  it("aborts an in-flight provider commit without waiting for its promise", async () => {
    const fake = makeProvider({ blockCommit: true });
    const provider = withSttReconnect(fake.provider, {
      jitter: false,
      initialBackoffMs: 0,
      maxBackoffMs: 0,
    });
    const stream = await provider.open(openRequest());
    const commit = stream.commit();
    await waitFor(() => fake.streams[0]?.order.includes("commit") === true);
    const commitRejection = expect(commit).rejects.toMatchObject({ code: "stt.reconnect.closed" });

    const abort = getSttRecoveryControl(stream)!.controller.abort(
      providerError("stt.reconnect.closed", "caller hung up", { retriable: false }),
    );
    await expect(abort).resolves.toBeUndefined();
    await commitRejection;
    await stream.close();
  });

  it("waits for every failed generation to close before opening the next one", async () => {
    const fake = makeProvider({ closeDelayMs: 20 });
    const provider = withSttReconnect(fake.provider, {
      jitter: false,
      initialBackoffMs: 0,
      maxBackoffMs: 0,
      connectTimeoutMs: 50,
      commitTimeoutMs: 50,
      stableUptimeMs: 5,
      maxRecoveryDurationMs: 200,
      maxAttempts: 3,
    });
    const stream = await provider.open(openRequest());
    const first = fake.streams[0]!;
    first.failNextAudio = true;
    await stream.sendAudio(audioChunk(1));
    await waitFor(() => fake.streams.length === 2);

    const second = fake.streams[1]!;
    second.failNextAudio = true;
    await stream.sendAudio(audioChunk(2));
    await waitFor(() => fake.streams.length === 3);

    expect(fake.openWhileClosing).toBe(false);
    await stream.close();
  });
});

interface FakeGeneration {
  readonly events: AsyncQueue<TranscriptEvent>;
  readonly order: string[];
  stream: SttStream;
  failNextAudio: boolean;
  closed: boolean;
}

function makeProvider(
  options: {
    readonly timestampOrigin?: "generation";
    readonly missingTimestampOrigin?: boolean;
    readonly failInitialAudio?: boolean;
    readonly failReconnectOpen?: "auth" | "transient";
    readonly blockCommit?: boolean;
    readonly blockReconnectAudio?: boolean;
    readonly closeDelayMs?: number;
  } = {},
) {
  const streams: FakeGeneration[] = [];
  let openCalls = 0;
  let releaseReconnectAudio: (() => void) | undefined;
  let closingStreams = 0;
  let openWhileClosing = false;
  const provider: SpeechToTextProvider = {
    name: "fake-reconnect-stt",
    kind: "stt",
    version: "0.1.0",
    capabilities: CAPABILITIES,
    async open(): Promise<SttStream> {
      openCalls += 1;
      openWhileClosing ||= closingStreams > 0;
      if (openCalls > 1 && options.failReconnectOpen) {
        throw providerError(
          options.failReconnectOpen === "auth"
            ? "stt.provider.auth_failed"
            : "stt.transport.connect_failed",
          "fake reconnect open failed",
          {
            provider: "fake-reconnect-stt",
            retriable: options.failReconnectOpen !== "auth",
          },
        );
      }
      const events = new AsyncQueue<TranscriptEvent>();
      const order: string[] = [];
      const generation: FakeGeneration = {
        events,
        order,
        failNextAudio: options.failInitialAudio === true && streams.length === 0,
        closed: false,
        stream: undefined as never,
      };
      generation.stream = {
        events,
        commitMode: "provider",
        ...(options.missingTimestampOrigin
          ? {}
          : { timestampOrigin: options.timestampOrigin ?? "generation" }),
        async sendAudio(chunk: InputAudioChunk) {
          if (generation.failNextAudio) {
            generation.failNextAudio = false;
            throw providerError("stt.transport.write_failed", "fake write failed", {
              provider: "fake-reconnect-stt",
              retriable: true,
            });
          }
          if (options.blockReconnectAudio && streams.length > 1) {
            await new Promise<void>((resolve) => {
              releaseReconnectAudio = resolve;
            });
          }
          generation.order.push(`audio:${chunk.audio.bytes[0] ?? 0}`);
        },
        async commit() {
          generation.order.push("commit");
          if (options.blockCommit) {
            await new Promise<void>(() => undefined);
          }
        },
        async close() {
          // Keep the fake queue alive so a stale event can be injected after a
          // generation is fenced; the wrapper must ignore it by identity.
          if (generation.closed) {
            return;
          }
          generation.closed = true;
          closingStreams += 1;
          await new Promise<void>((resolve) => setTimeout(resolve, options.closeDelayMs ?? 0));
          closingStreams -= 1;
        },
      };
      streams.push(generation);
      return generation.stream;
    },
  };
  return {
    provider,
    streams,
    get openCalls() {
      return openCalls;
    },
    get openWhileClosing() {
      return openWhileClosing;
    },
    releaseReconnectAudio(): void {
      releaseReconnectAudio?.();
      releaseReconnectAudio = undefined;
    },
  };
}

function openRequest(): SttOpenRequest {
  return {
    sessionId: "resilient_session" as SessionId,
    format: PCM16_16K_MONO,
    interimResults: true,
  };
}

function audioChunk(value: number, byteLength = 2): InputAudioChunk {
  return {
    id: `audio_${value}` as never,
    type: "media.audio.chunk",
    sessionId: "resilient_session" as SessionId,
    sequence: value,
    direction: "input",
    timestamp: TS,
    monotonicOffsetMs: value,
    audio: {
      format: PCM16_16K_MONO,
      durationMs: 1,
      frameCount: byteLength / 2,
      bytes: new Uint8Array(byteLength).fill(value),
    },
  };
}

function transcript(
  type: "stt.final",
  text: string,
  audioStartMs: number,
  audioEndMs: number,
): TranscriptEvent {
  return {
    id: "final" as never,
    type,
    direction: "input",
    sessionId: "resilient_session" as SessionId,
    sequence: 1,
    provider: "fake-reconnect-stt",
    text,
    startTimestamp: TS,
    endTimestamp: TS,
    audioStartMs,
    audioEndMs,
  };
}

function endpointTranscript(): TranscriptEvent {
  return {
    id: "endpoint" as never,
    type: "stt.endpoint",
    direction: "input",
    sessionId: "resilient_session" as SessionId,
    sequence: 1,
    provider: "fake-reconnect-stt",
    reason: "manual",
    timestamp: TS,
    audioOffsetMs: 20,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for resilient STT state");
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const TS = "2026-08-25T00:00:00.000Z" as never;
