import { describe, expect, it } from "vitest";

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
