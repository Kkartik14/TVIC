import { describe, expect, it, vi } from "vitest";

import {
  createMediaEvent,
  PCM16_16K_MONO,
  type CallHandle,
  type InboundMediaEvent,
  type OutputMediaEvent,
  type TtsEvent,
  type TtsStream,
} from "@tvic/core";

import { playPipelineTtsStream } from "../src/pipeline-tts-playback.js";
import type { ActiveTurnControl, MutableTurnLatency } from "../src/turn-state.js";

const TIMESTAMP = "2026-09-07T00:00:00.000Z" as never;

describe("playPipelineTtsStream", () => {
  it("processes alignment, flush, audio, and commit events in order", async () => {
    const sent: OutputMediaEvent[] = [];
    const emitted: Array<{ readonly bytes: Uint8Array; readonly sequence: number }> = [];
    const confirmed: string[] = [];
    let cancelled = false;
    const callHandle: CallHandle = {
      callId: "call_playback" as never,
      events: emptyInboundEvents(),
      async send(event) {
        sent.push(event);
        return true;
      },
      async clear() {},
      async close() {},
      async confirmPlayout(markId) {
        confirmed.push(markId);
        return true;
      },
    };
    const chunk = createMediaEvent({
      id: "chunk_1" as never,
      type: "media.audio.chunk",
      sessionId: "session_playback" as never,
      turnId: "turn_playback" as never,
      sequence: 3,
      direction: "output",
      timestamp: TIMESTAMP,
      monotonicOffsetMs: 0,
      provider: "test-tts",
      audio: {
        format: PCM16_16K_MONO,
        durationMs: 20,
        frameCount: 320,
        bytes: new Uint8Array([1, 2, 3, 4]),
      },
    });
    const committed = createMediaEvent({
      id: "commit_1" as never,
      type: "media.audio.committed",
      sessionId: "session_playback" as never,
      turnId: "turn_playback" as never,
      sequence: 4,
      direction: "output",
      timestamp: TIMESTAMP,
      monotonicOffsetMs: 0,
      provider: "test-tts",
      durationMs: 20,
      frameCount: 320,
      sequenceRange: [3, 3],
      chunkIds: [chunk.id],
    });
    const stream: TtsStream = {
      events: scriptedEvents([
        {
          type: "tts.alignment",
          sessionId: "session_playback" as never,
          turnId: "turn_playback" as never,
          sequence: 1,
          provider: "test-tts",
          timestamp: TIMESTAMP,
          unit: "word",
          tokens: ["hello"],
          startMs: [0],
          endMs: [100],
        },
        {
          type: "tts.flush.completed",
          sessionId: "session_playback" as never,
          turnId: "turn_playback" as never,
          sequence: 2,
          provider: "test-tts",
          timestamp: TIMESTAMP,
          flushId: "flush_1",
          acknowledgedBy: "provider",
        },
        chunk,
        committed,
      ]),
      async cancel() {
        cancelled = true;
      },
    };
    const control = activeTurnControl();
    const latency: MutableTurnLatency = {};

    await playPipelineTtsStream(stream, control, latency, {
      sessionId: "session_playback",
      turnId: "turn_playback",
      callHandle,
      stallTimeoutMs: 1_000,
      onTimeout: "fail",
      monotonicMs: () => 123,
      abortActive: () => {
        throw new Error("unexpected abort");
      },
      emitAudio(bytes, sequence) {
        emitted.push({ bytes, sequence });
      },
    });

    expect(cancelled).toBe(false);
    expect(sent.map((event) => event.type)).toEqual(["media.audio.chunk", "media.audio.committed"]);
    expect(sent[0]).toMatchObject({ monotonicOffsetMs: 123, sequence: 3 });
    expect(emitted).toEqual([{ bytes: new Uint8Array([1, 2, 3, 4]), sequence: 3 }]);
    expect(confirmed).toEqual(["commit_1"]);
    expect(control.alignedTokens).toEqual(["hello"]);
    expect(control.alignedUnit).toBe("word");
    expect(control.alignedDurationMs).toBe(100);
    expect(control.lastFlushSequence).toBe(2);
    expect(control.outputFramesSent).toBe(320);
    expect(control.outputDelivered).toBe(true);
    expect(control.speaking).toBe(false);
    expect(latency.firstAudioMs).toBe(23);
  });

  it("warns and ignores an empty audio chunk", async () => {
    const sent: OutputMediaEvent[] = [];
    const warnings: Array<{ readonly code: string; readonly provider?: string }> = [];
    const stream: TtsStream = {
      events: scriptedEvents([
        createMediaEvent({
          id: "empty_chunk" as never,
          type: "media.audio.chunk",
          sessionId: "session_playback" as never,
          turnId: "turn_playback" as never,
          sequence: 1,
          direction: "output",
          timestamp: TIMESTAMP,
          monotonicOffsetMs: 0,
          provider: "test-tts",
          audio: {
            format: PCM16_16K_MONO,
            durationMs: 0,
            frameCount: 0,
            bytes: new Uint8Array(),
          },
        }),
      ]),
      async cancel() {},
    };

    await playPipelineTtsStream(
      stream,
      activeTurnControl(),
      {},
      {
        sessionId: "session_playback",
        turnId: "turn_playback",
        callHandle: {
          callId: "call_playback" as never,
          events: emptyInboundEvents(),
          async send(event) {
            sent.push(event);
            return true;
          },
          async clear() {},
          async close() {},
        },
        stallTimeoutMs: 1_000,
        onTimeout: "fail",
        monotonicMs: () => 123,
        abortActive: () => {
          throw new Error("unexpected abort");
        },
        emitAudio: () => {
          throw new Error("empty audio must not be emitted");
        },
        onWarning(error) {
          warnings.push({
            code: error.code,
            ...(error.provider ? { provider: error.provider } : {}),
          });
        },
      },
    );

    expect(sent).toEqual([]);
    expect(warnings).toEqual([{ code: "tts.empty_chunk", provider: "test-tts" }]);
  });

  it("bounds a transport send that never acknowledges an audio frame", async () => {
    vi.useFakeTimers();
    try {
      const chunk = createMediaEvent({
        id: "send_timeout_chunk" as never,
        type: "media.audio.chunk",
        sessionId: "session_playback" as never,
        turnId: "turn_playback" as never,
        sequence: 1,
        direction: "output",
        timestamp: TIMESTAMP,
        monotonicOffsetMs: 0,
        provider: "test-tts",
        audio: {
          format: PCM16_16K_MONO,
          durationMs: 20,
          frameCount: 320,
          bytes: new Uint8Array([1, 2]),
        },
      });
      let sendStarted = false;
      let cancelled = false;
      let abortReason = "";
      const running = playPipelineTtsStream(
        {
          events: scriptedEvents([chunk]),
          async cancel() {
            cancelled = true;
          },
        },
        activeTurnControl(),
        {},
        {
          sessionId: "session_playback",
          turnId: "turn_playback",
          callHandle: {
            callId: "call_playback" as never,
            events: emptyInboundEvents(),
            async send() {
              sendStarted = true;
              return new Promise<boolean>(() => {});
            },
            async clear() {},
            async close() {},
          },
          stallTimeoutMs: 1_000,
          sendTimeoutMs: 10,
          onTimeout: "fail",
          monotonicMs: () => 123,
          abortActive: (reason) => {
            abortReason = reason;
          },
          emitAudio: () => {},
        },
      );
      const failure = expect(running).rejects.toMatchObject({
        code: "media.send_timeout",
        category: "timeout",
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(sendStarted).toBe(true);
      await vi.advanceTimersByTimeAsync(10);
      await failure;
      expect(abortReason).toBe("transport_send_timeout");
      expect(cancelled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a playout confirmation that ignores its timeout argument", async () => {
    vi.useFakeTimers();
    try {
      let confirmStarted!: () => void;
      const confirmationStarted = new Promise<void>((resolve) => {
        confirmStarted = resolve;
      });
      const chunk = createMediaEvent({
        id: "timeout_chunk" as never,
        type: "media.audio.chunk",
        sessionId: "session_playback" as never,
        turnId: "turn_playback" as never,
        sequence: 1,
        direction: "output",
        timestamp: TIMESTAMP,
        monotonicOffsetMs: 0,
        provider: "test-tts",
        audio: {
          format: PCM16_16K_MONO,
          durationMs: 20,
          frameCount: 320,
          bytes: new Uint8Array([1, 2]),
        },
      });
      const committed = createMediaEvent({
        id: "timeout_commit" as never,
        type: "media.audio.committed",
        sessionId: "session_playback" as never,
        turnId: "turn_playback" as never,
        sequence: 2,
        direction: "output",
        timestamp: TIMESTAMP,
        monotonicOffsetMs: 0,
        provider: "test-tts",
        durationMs: 20,
        frameCount: 320,
        sequenceRange: [1, 1],
        chunkIds: [chunk.id],
      });
      const control = activeTurnControl();
      const stream: TtsStream = {
        events: scriptedEvents([chunk, committed]),
        async cancel() {},
      };
      const running = playPipelineTtsStream(
        stream,
        control,
        {},
        {
          sessionId: "session_playback",
          turnId: "turn_playback",
          callHandle: {
            callId: "call_playback" as never,
            events: emptyInboundEvents(),
            async send() {
              return true;
            },
            async clear() {},
            async close() {},
            async confirmPlayout() {
              confirmStarted();
              return new Promise<boolean>(() => {});
            },
          },
          stallTimeoutMs: 1_000,
          onTimeout: "fail",
          monotonicMs: () => 123,
          abortActive: () => {},
          emitAudio: () => {},
        },
      );

      await confirmationStarted;
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(running).resolves.toBeUndefined();
      expect(control.outputDelivered).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a TTS event from another session and cancels the stream", async () => {
    let cancelled = false;
    const foreign = createMediaEvent({
      id: "foreign_chunk" as never,
      type: "media.audio.chunk",
      sessionId: "foreign_session" as never,
      turnId: "turn_playback" as never,
      sequence: 1,
      direction: "output",
      timestamp: TIMESTAMP,
      monotonicOffsetMs: 0,
      provider: "test-tts",
      audio: {
        format: PCM16_16K_MONO,
        durationMs: 20,
        frameCount: 320,
        bytes: new Uint8Array([1, 2]),
      },
    });
    const stream: TtsStream = {
      events: scriptedEvents([foreign]),
      async cancel() {
        cancelled = true;
      },
    };

    await expect(
      playPipelineTtsStream(
        stream,
        activeTurnControl(),
        {},
        {
          sessionId: "session_playback",
          turnId: "turn_playback",
          callHandle: {
            callId: "call_playback" as never,
            events: emptyInboundEvents(),
            async send() {
              return true;
            },
            async clear() {},
            async close() {},
          },
          stallTimeoutMs: 1_000,
          onTimeout: "fail",
          monotonicMs: () => 123,
          abortActive: () => {},
          emitAudio: () => {},
        },
      ),
    ).rejects.toMatchObject({ code: "provider.identity_mismatch" });
    expect(cancelled).toBe(true);
  });

  it("releases the stream iterator when flush order is violated", async () => {
    let cancelled = false;
    let released = false;
    const flush = (sequence: number): TtsEvent =>
      ({
        type: "tts.flush.completed",
        sessionId: "session_playback" as never,
        turnId: "turn_playback" as never,
        sequence,
        provider: "test-tts",
        timestamp: TIMESTAMP,
        flushId: `flush_${sequence}`,
        acknowledgedBy: "provider",
      }) as TtsEvent;
    const stream: TtsStream = {
      events: (async function* () {
        try {
          yield flush(2);
          yield flush(1);
        } finally {
          released = true;
        }
      })(),
      async cancel() {
        cancelled = true;
      },
    };
    await expect(
      playPipelineTtsStream(
        stream,
        activeTurnControl(),
        {},
        {
          sessionId: "session_playback",
          turnId: "turn_playback",
          callHandle: {
            callId: "call_playback" as never,
            events: emptyInboundEvents(),
            async send() {
              return true;
            },
            async clear() {},
            async close() {},
          },
          stallTimeoutMs: 1_000,
          onTimeout: "fail",
          monotonicMs: () => 123,
          abortActive: () => {},
          emitAudio: () => {},
        },
      ),
    ).rejects.toMatchObject({ code: "tts.flush_out_of_order" });
    expect(cancelled).toBe(true);
    expect(released).toBe(true);
  });

  it("cleans up when the provider event iterator rejects", async () => {
    let cancelled = 0;
    let returned = 0;
    const failure = new Error("provider event stream failed");
    const stream: TtsStream = {
      events: {
        [Symbol.asyncIterator](): AsyncIterator<TtsEvent> {
          return {
            next: () => Promise.reject(failure),
            return: async () => {
              returned += 1;
              return { done: true, value: undefined };
            },
          };
        },
      },
      async cancel() {
        cancelled += 1;
      },
    };

    await expect(
      playPipelineTtsStream(
        stream,
        activeTurnControl(),
        {},
        {
          sessionId: "session_playback",
          turnId: "turn_playback",
          callHandle: {
            callId: "call_playback" as never,
            events: emptyInboundEvents(),
            async send() {
              return true;
            },
            async clear() {},
            async close() {},
          },
          stallTimeoutMs: 1_000,
          onTimeout: "fail",
          monotonicMs: () => 123,
          abortActive: () => {},
          emitAudio: () => {},
        },
      ),
    ).rejects.toThrow("provider event stream failed");
    expect(cancelled).toBe(1);
    expect(returned).toBe(1);
  });

  it("cancels when the provider throws while creating its event iterator", async () => {
    let cancelled = 0;
    const failure = new Error("provider iterator creation failed");
    const stream: TtsStream = {
      events: {
        [Symbol.asyncIterator](): AsyncIterator<TtsEvent> {
          throw failure;
        },
      },
      async cancel() {
        cancelled += 1;
      },
    };

    await expect(
      playPipelineTtsStream(
        stream,
        activeTurnControl(),
        {},
        {
          sessionId: "session_playback",
          turnId: "turn_playback",
          callHandle: {
            callId: "call_playback" as never,
            events: emptyInboundEvents(),
            async send() {
              return true;
            },
            async clear() {},
            async close() {},
          },
          stallTimeoutMs: 1_000,
          onTimeout: "fail",
          monotonicMs: () => 123,
          abortActive: () => {},
          emitAudio: () => {},
        },
      ),
    ).rejects.toThrow("provider iterator creation failed");
    expect(cancelled).toBe(1);
  });
});

async function* scriptedEvents(events: readonly TtsEvent[]): AsyncIterable<TtsEvent> {
  for (const event of events) yield event;
}

async function* emptyInboundEvents(): AsyncIterable<InboundMediaEvent> {
  // The playback helper does not consume inbound call events; this satisfies
  // the CallHandle contract without introducing an unrelated queue.
}

function activeTurnControl(): ActiveTurnControl {
  return {
    turnId: "turn_playback" as never,
    abort: new AbortController(),
    startedAtMs: 100,
    interruptedAtMs: null,
    interruptionTailMs: null,
    cancelReason: "explicit",
    outputFramesSent: 0,
    speaking: false,
    outputDelivered: false,
    alignedTokens: [],
    alignedUnit: null,
    alignedCharacterStarts: new Set(),
    alignedDurationMs: 0,
    lastFlushSequence: null,
  };
}
