import { describe, expect, it } from "vitest";

import type { MediaEvent, MediaEventId, SessionId, Timestamp } from "@tvic/core";

import {
  createMediaEventBuffer,
  isInputMediaEvent,
  isOutputMediaEvent,
} from "../src/index.js";

const sessionId = "session_test" as SessionId;
const timestamp = "2026-05-20T00:00:00.000Z" as Timestamp;

function event(id: string, direction: MediaEvent["direction"]): MediaEvent {
  if (direction === "output") {
    return {
      id: id as MediaEventId,
      type: "media.audio.chunk",
      sessionId,
      sequence: 1,
      direction,
      timestamp,
      audio: {
        format: { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1 },
        durationMs: 20,
        frameCount: 320,
        data: { kind: "inline", bytes: new Uint8Array([1, 2, 3]) },
      },
    };
  }

  return {
    id: id as MediaEventId,
    type: "speech.started",
    sessionId,
    sequence: 1,
    direction: "input",
    timestamp,
  };
}

describe("MediaEventBuffer", () => {
  it("stores and queries normalized events by direction", () => {
    const buffer = createMediaEventBuffer();
    const input = event("media_input", "input");
    const output = event("media_output", "output");

    buffer.append(input);
    buffer.append(output);

    expect(buffer.query({ direction: "input" })).toEqual([input]);
    expect(buffer.query({ direction: "output" })).toEqual([output]);
    expect(isInputMediaEvent(input)).toBe(true);
    expect(isOutputMediaEvent(output)).toBe(true);
  });
});
