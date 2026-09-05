import { describe, expect, it } from "vitest";

import {
  PCM16_16K_MONO,
  TvicThrowableError,
  type InputAudioChunk,
  type ProviderCapabilities,
  type SessionId,
  type SpeechToTextProvider,
  type SttOpenRequest,
  type SttStream,
  type TranscriptEvent,
} from "@tvic/core";
import { AsyncQueue } from "@tvic/media";

import { createSttSession } from "../src/stt-session.js";

const CAPABILITIES = {
  streaming: { input: true, output: false, native: true },
  cancellation: { request: true, output: false, buffer: false, truncation: false },
  transports: ["websocket"],
  audio: { input: [PCM16_16K_MONO] },
} satisfies ProviderCapabilities;

describe("SttSession", () => {
  it("opens a provider-neutral stream and forwards provider events", async () => {
    const fake = makeProvider();
    const session = await createSttSession({
      provider: fake.provider,
      format: PCM16_16K_MONO,
      model: "custom-stt",
      language: "en-US",
      interimResults: false,
      vocabulary: ["TVIC"],
      metadata: { test: true },
    });

    expect(fake.request).toEqual(
      expect.objectContaining({
        format: PCM16_16K_MONO,
        model: "custom-stt",
        language: "en-US",
        interimResults: false,
        vocabulary: ["TVIC"],
        metadata: { test: true },
      }),
    );

    const event: TranscriptEvent = {
      id: "provider_event_1" as never,
      type: "stt.final",
      direction: "input",
      sessionId: session.sessionId,
      sequence: 1,
      provider: "different-shaped-stt",
      text: "hello",
      startTimestamp: "2026-08-19T00:00:00.000Z" as never,
      endTimestamp: "2026-08-19T00:00:00.000Z" as never,
    };
    fake.pushEvent(event);

    await expect(session.events[Symbol.asyncIterator]().next()).resolves.toEqual({
      done: false,
      value: event,
    });
    await session.close();
  });

  it("frames PCM16 input with contiguous IDs, sequences, duration, and timestamps", async () => {
    const fake = makeProvider();
    const session = await createSttSession({
      provider: fake.provider,
      format: PCM16_16K_MONO,
      sessionId: "session_supplied" as SessionId,
      idGenerator: deterministicIds(),
      clock: {
        now: () => "2026-08-19T00:00:00.000Z" as never,
        monotonicMs: () => 42,
      },
    });

    await session.pushPcm16(new Uint8Array(640), { monotonicOffsetMs: 12 });
    await session.pushPcm16(new Uint8Array(320));

    expect(fake.audio).toHaveLength(2);
    expect(fake.audio[0]).toEqual(
      expect.objectContaining({
        id: "media_1",
        sequence: 1,
        sessionId: "session_supplied",
        monotonicOffsetMs: 12,
        audio: expect.objectContaining({ frameCount: 320, durationMs: 20 }),
      }),
    );
    expect(fake.audio[1]).toEqual(
      expect.objectContaining({
        id: "media_2",
        sequence: 2,
        monotonicOffsetMs: 42,
        audio: expect.objectContaining({ frameCount: 160, durationMs: 10 }),
      }),
    );
    await session.close();
  });

  it("normalizes an explicit source format while opening the provider at the target format", async () => {
    const fake = makeProvider();
    const sourceFormat = { encoding: "pcm_s16le", sampleRateHz: 48000, channels: 1 } as const;
    const session = await createSttSession({
      provider: fake.provider,
      format: PCM16_16K_MONO,
      input: { format: sourceFormat, normalization: "auto" },
    });

    expect(fake.request?.format).toEqual(PCM16_16K_MONO);
    await session.pushPcm16(new Uint8Array(480 * 2));
    await session.commit();

    expect(fake.audio.length).toBeGreaterThan(0);
    expect(fake.audio.every((chunk) => chunk.audio.format === PCM16_16K_MONO)).toBe(true);
    expect(fake.audio.reduce((total, chunk) => total + chunk.audio.frameCount, 0)).toBe(160);
    expect(fake.audio.map((chunk) => chunk.sequence)).toEqual(
      fake.audio.map((_, index) => index + 1),
    );
    await session.close();
  });

  it("keeps normalization, commit, and later source audio in one FIFO", async () => {
    const fake = makeProvider();
    const sourceFormat = { encoding: "pcm_s16le", sampleRateHz: 8000, channels: 1 } as const;
    const session = await createSttSession({
      provider: fake.provider,
      format: PCM16_16K_MONO,
      input: { format: sourceFormat, normalization: "auto" },
    });

    const first = session.pushPcm16(new Uint8Array(160 * 2));
    const committed = session.commit();
    const second = session.pushPcm16(new Uint8Array(160 * 2));
    await Promise.all([first, committed, second]);

    expect(fake.order).toEqual(["audio", "audio", "commit", "audio"]);
    expect(fake.audio.slice(0, 2).reduce((total, chunk) => total + chunk.audio.frameCount, 0)).toBe(
      320,
    );
    await session.close();
  });

  it("requires matching formats when normalization is disabled", async () => {
    const fake = makeProvider();

    await expect(
      createSttSession({
        provider: fake.provider,
        format: PCM16_16K_MONO,
        input: {
          format: { encoding: "pcm_s16le", sampleRateHz: 48000, channels: 1 },
          normalization: "never",
        },
      }),
    ).rejects.toMatchObject({ code: "stt.normalization_disabled_format_mismatch" });
  });

  it("serializes audio, commit, and close while coalescing duplicate commits", async () => {
    const fake = makeProvider({ blockAudio: true });
    const session = await createSttSession({ provider: fake.provider, format: PCM16_16K_MONO });

    const firstPush = session.pushPcm16(new Uint8Array(320));
    const firstCommit = session.commit();
    const duplicateCommit = session.commit();
    const close = session.close();

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(fake.order).toEqual(["audio"]);
    fake.releaseAudio();
    await firstPush;
    await firstCommit;
    await duplicateCommit;
    await close;
    expect(fake.order).toEqual(["audio", "commit", "close"]);
    expect(fake.commitCalls).toBe(1);

    const second = makeProvider();
    const secondSession = await createSttSession({
      provider: second.provider,
      format: PCM16_16K_MONO,
    });
    await secondSession.pushPcm16(new Uint8Array(320));
    await secondSession.commit();
    await secondSession.pushPcm16(new Uint8Array(320));
    await secondSession.commit();
    expect(second.commitCalls).toBe(2);
    await secondSession.close();
  });

  it("rejects incompatible input and input after close", async () => {
    const fake = makeProvider();
    const session = await createSttSession({ provider: fake.provider, format: PCM16_16K_MONO });
    const wrongSessionChunk = {
      ...makeChunk(session.sessionId),
      sessionId: "another_session" as SessionId,
    };

    await expect(session.pushAudioChunk(wrongSessionChunk)).rejects.toMatchObject({
      code: "stt.audio_session_mismatch",
    });
    await expect(session.pushPcm16(new Uint8Array(3))).rejects.toMatchObject({
      code: "stt.audio_odd_byte_length",
    });
    await session.close();
    await expect(session.pushPcm16(new Uint8Array(2))).rejects.toThrow("closed");
  });

  it("aborts a hanging provider open and enforces the startup timeout", async () => {
    const controller = new AbortController();
    const hanging = makeProvider({ hangOpen: true });
    const opening = createSttSession({
      provider: hanging.provider,
      format: PCM16_16K_MONO,
      signal: controller.signal,
      openTimeoutMs: 1000,
    });
    controller.abort();
    await expect(opening).rejects.toMatchObject({
      name: "CancelledError",
      code: "stt.open_cancelled",
      category: "cancelled",
    });

    const timed = makeProvider({ hangOpen: true });
    await expect(
      createSttSession({ provider: timed.provider, format: PCM16_16K_MONO, openTimeoutMs: 1 }),
    ).rejects.toMatchObject({
      name: "TimeoutError",
      code: "stt.open_timeout",
      category: "timeout",
    });

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(
      createSttSession({
        provider: makeProvider({ hangOpen: true }).provider,
        format: PCM16_16K_MONO,
        signal: alreadyAborted.signal,
      }),
    ).rejects.toMatchObject({
      name: "CancelledError",
      code: "stt.open_cancelled",
      category: "cancelled",
    });
  });

  it("propagates a provider event-stream failure through session.events", async () => {
    const fake = makeProvider();
    const session = await createSttSession({ provider: fake.provider, format: PCM16_16K_MONO });
    const failure = new Error("deepgram socket reset");

    const next = session.events[Symbol.asyncIterator]().next();
    fake.failEvents(failure);

    await expect(next).rejects.toBeInstanceOf(TvicThrowableError);
    await expect(next).rejects.toMatchObject({ message: failure.message });
    await session.close();
  });

  it("keeps serializing operations after a failed send, and rejects new input once the provider stream ends mid-push", async () => {
    const fake = makeProvider({ blockAudio: true });
    const session = await createSttSession({ provider: fake.provider, format: PCM16_16K_MONO });

    const inFlightPush = session.pushPcm16(new Uint8Array(320));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(fake.order).toEqual(["audio"]);

    // The provider's own event stream ends while the send is still in flight.
    fake.endEvents();
    fake.releaseAudio();
    await inFlightPush; // the in-flight send itself still resolves on its own terms

    // The provider stream is now terminal, so new input fails clearly instead of
    // being sent into a socket that has already ended.
    await expect(session.pushPcm16(new Uint8Array(320))).rejects.toThrow("ended");
    await session.close();
  });

  it("keeps the operation queue running after a failed send", async () => {
    const fake = makeProvider({ failNextAudio: true });
    const session = await createSttSession({ provider: fake.provider, format: PCM16_16K_MONO });

    await expect(session.pushPcm16(new Uint8Array(320))).rejects.toThrow("provider send failed");
    // The queue is not wedged by the rejected operation: commit still runs after it.
    await session.commit();
    expect(fake.order).toEqual(["audio_failed", "commit"]);
    await session.close();
  });

  it("settles close() with the provider's close failure, but still closes the local event stream", async () => {
    const fake = makeProvider({ failClose: true });
    const session = await createSttSession({ provider: fake.provider, format: PCM16_16K_MONO });

    await expect(session.close()).rejects.toThrow("provider close failed");
    // Cleanup still runs even though the provider's own close() rejected, so a
    // consumer of `events` is never left hanging on a stream the session gave up on.
    await expect(session.events[Symbol.asyncIterator]().next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it("lets abort bypass a blocked FIFO without flushing queued normalization residue", async () => {
    const controller = new AbortController();
    const fake = makeProvider({ blockAudio: true });
    const sourceFormat = { encoding: "pcm_s16le", sampleRateHz: 8000, channels: 1 } as const;
    const session = await createSttSession({
      provider: fake.provider,
      format: PCM16_16K_MONO,
      input: { format: sourceFormat, normalization: "auto" },
      signal: controller.signal,
    });

    const inFlightPush = session.pushPcm16(new Uint8Array(320));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const queuedPush = session.pushPcm16(new Uint8Array(2));

    const started = Date.now();
    controller.abort();
    await expect(session.close()).resolves.toBeUndefined();
    await expect(inFlightPush).rejects.toMatchObject({ code: "stt.session_closed" });
    await expect(queuedPush).rejects.toMatchObject({ code: "stt.session_closed" });

    expect(Date.now() - started).toBeLessThan(100);
    expect(fake.order).toEqual(["audio", "close"]);
  });

  it("coalesces one logical commit while replaying its physical barrier across generations", async () => {
    const fake = makeProvider({ timestampOrigin: "generation", failNextCommit: true });
    const session = await createSttSession({
      provider: fake.provider,
      format: PCM16_16K_MONO,
      sttReconnect: {
        jitter: false,
        initialBackoffMs: 0,
        maxBackoffMs: 0,
        stableUptimeMs: 5,
      },
    });

    await session.pushPcm16(new Uint8Array(320));
    const first = session.commit();
    const duplicate = session.commit();
    expect(duplicate).toBe(first);
    await Promise.all([first, duplicate]);

    expect(fake.openCalls).toBe(2);
    expect(fake.commitCalls).toBe(2);
    await session.close();
  });
});

function makeProvider(
  options: {
    readonly hangOpen?: boolean;
    readonly blockAudio?: boolean;
    readonly failNextAudio?: boolean;
    readonly failClose?: boolean;
    readonly failNextCommit?: boolean;
    readonly timestampOrigin?: "generation";
  } = {},
) {
  let queue = new AsyncQueue<TranscriptEvent>();
  const audio: InputAudioChunk[] = [];
  const order: string[] = [];
  let releaseAudio = (): void => undefined;
  let commitCalls = 0;
  let sendAudioCalls = 0;
  let openCalls = 0;
  let request: SttOpenRequest | undefined;
  const provider: SpeechToTextProvider = {
    name: "different-shaped-stt",
    kind: "stt",
    version: "test",
    capabilities: CAPABILITIES,
    async open(nextRequest): Promise<SttStream> {
      openCalls += 1;
      request = nextRequest;
      if (options.hangOpen) {
        return new Promise<SttStream>(() => undefined);
      }
      queue = new AsyncQueue<TranscriptEvent>();
      return {
        events: queue,
        ...(options.timestampOrigin ? { timestampOrigin: options.timestampOrigin } : {}),
        async sendAudio(chunk) {
          sendAudioCalls += 1;
          if (options.failNextAudio && sendAudioCalls === 1) {
            order.push("audio_failed");
            throw new Error("provider send failed");
          }
          order.push("audio");
          audio.push(chunk);
          if (options.blockAudio) {
            await new Promise<void>((resolve) => {
              releaseAudio = resolve;
            });
          }
        },
        async commit() {
          order.push("commit");
          commitCalls += 1;
          if (options.failNextCommit && commitCalls === 1) {
            throw {
              name: "ProviderError",
              code: "stt.transport.write_failed",
              category: "provider",
              message: "provider commit failed",
              provider: "different-shaped-stt",
              retriable: true,
            };
          }
        },
        async close() {
          order.push("close");
          queue.close();
          if (options.failClose) {
            throw new Error("provider close failed");
          }
        },
      };
    },
  };
  return {
    provider,
    audio,
    order,
    get request() {
      return request;
    },
    get commitCalls() {
      return commitCalls;
    },
    get openCalls() {
      return openCalls;
    },
    pushEvent(event: TranscriptEvent) {
      queue.push(event);
    },
    failEvents(error: unknown) {
      queue.fail(error);
    },
    endEvents() {
      queue.close();
    },
    releaseAudio() {
      releaseAudio();
    },
  };
}

function makeChunk(sessionId: SessionId): InputAudioChunk {
  return {
    id: "chunk_1" as never,
    type: "media.audio.chunk",
    sessionId,
    sequence: 1,
    direction: "input",
    timestamp: "2026-08-19T00:00:00.000Z" as never,
    monotonicOffsetMs: 0,
    audio: {
      format: PCM16_16K_MONO,
      durationMs: 0,
      frameCount: 0,
      bytes: new Uint8Array(),
    },
  };
}

function deterministicIds() {
  let next = 1;
  const id = (prefix: string) => () => `${prefix}_${next++}` as never;
  return {
    agent: id("agent"),
    session: id("session"),
    call: id("call"),
    turn: id("turn"),
    tool: id("tool"),
    toolCall: id("tool_call"),
    mediaEvent: id("media"),
    memoryEntry: id("memory"),
  };
}
