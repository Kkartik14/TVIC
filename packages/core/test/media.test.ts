import { describe, expect, it } from "vitest";

import {
  EVENT_KIND_MAP,
  createMediaEvent,
  kindForMediaEvent,
  PCM16_16K_MONO,
  type MediaAudioChunkEvent,
  type MediaEventType,
} from "../src/index.js";

describe("EVENT_KIND_MAP", () => {
  it("covers every MediaEventType", () => {
    const types: readonly MediaEventType[] = [
      "media.stream.started",
      "media.stream.ended",
      "media.audio.chunk",
      "media.audio.committed",
      "media.turn.commit_requested",
      "media.interrupt.requested",
      "dtmf.received",
      "media.error",
    ];
    for (const type of types) {
      expect(EVENT_KIND_MAP[type]).toBeDefined();
    }
  });

  it("classifies events as expected", () => {
    expect(EVENT_KIND_MAP["media.stream.started"]).toBe("lifecycle");
    expect(EVENT_KIND_MAP["media.stream.ended"]).toBe("lifecycle");
    expect(EVENT_KIND_MAP["media.error"]).toBe("lifecycle");
    expect(EVENT_KIND_MAP["media.audio.chunk"]).toBe("media");
    expect(EVENT_KIND_MAP["media.audio.committed"]).toBe("media");
    expect(EVENT_KIND_MAP["media.turn.commit_requested"]).toBe("signal");
    expect(EVENT_KIND_MAP["media.interrupt.requested"]).toBe("signal");
    expect(EVENT_KIND_MAP["dtmf.received"]).toBe("signal");
  });
});

describe("kindForMediaEvent", () => {
  it("returns the kind for a known type", () => {
    expect(kindForMediaEvent("media.audio.chunk")).toBe("media");
    expect(kindForMediaEvent("media.stream.started")).toBe("lifecycle");
    expect(kindForMediaEvent("dtmf.received")).toBe("signal");
  });
});

describe("createMediaEvent", () => {
  it("sets kind from the type", () => {
    const event = createMediaEvent({
      id: "evt_1" as never,
      type: "media.audio.chunk",
      sessionId: "sess_1" as never,
      sequence: 0,
      direction: "input",
      timestamp: "2026-01-01T00:00:00.000Z" as never,
      monotonicOffsetMs: 0,
      audio: {
        format: PCM16_16K_MONO,
        durationMs: 0,
        frameCount: 0,
        bytes: new Uint8Array(),
      },
    }) satisfies MediaAudioChunkEvent<"input">;
    expect(event.kind).toBe("media");
    expect(event.type).toBe("media.audio.chunk");
  });

  it("preserves all base and type-specific fields", () => {
    const event = createMediaEvent<MediaAudioChunkEvent<"input">>({
      id: "evt_1" as never,
      type: "media.audio.chunk",
      sessionId: "sess_1" as never,
      callId: "call_1" as never,
      sequence: 42,
      direction: "input",
      timestamp: "2026-01-01T00:00:00.000Z" as never,
      monotonicOffsetMs: 100,
      provider: "test-provider",
      audio: {
        format: PCM16_16K_MONO,
        durationMs: 20,
        frameCount: 320,
        bytes: new Uint8Array(640),
      },
      metadata: { foo: "bar" },
    });
    expect(event).toEqual({
      id: "evt_1",
      type: "media.audio.chunk",
      kind: "media",
      sessionId: "sess_1",
      callId: "call_1",
      sequence: 42,
      direction: "input",
      timestamp: "2026-01-01T00:00:00.000Z",
      monotonicOffsetMs: 100,
      provider: "test-provider",
      audio: {
        format: PCM16_16K_MONO,
        durationMs: 20,
        frameCount: 320,
        bytes: expect.any(Uint8Array),
      },
      metadata: { foo: "bar" },
    });
  });
});
