import { describe, expect, it } from "vitest";

import {
  PCM16_16K_MONO,
  nowTimestamp,
  type InputAudioChunk,
  type SessionId,
  type SttOpenRequest,
  type TtsEvent,
  type TtsSynthesisRequest,
} from "@tvic/core";

import { createMockVoiceProviders } from "../src/mock-providers.js";

describe("voice-mode mock providers", () => {
  it("supports repeated explicit push-to-talk commits", async () => {
    const { stt } = createMockVoiceProviders();
    const stream = await stt.open(openRequest("push_to_talk"));
    const iterator = stream.events[Symbol.asyncIterator]();

    const firstFinal = iterator.next();
    await stream.sendAudio(audioChunk(1));
    await stream.commit();
    expect((await firstFinal).value).toMatchObject({
      type: "stt.final",
      text: expect.stringContaining("turn 1"),
    });
    expect((await next(iterator)).value?.type).toBe("stt.endpoint");

    const secondFinal = iterator.next();
    await stream.sendAudio(audioChunk(2));
    await stream.commit();
    expect((await secondFinal).value).toMatchObject({
      type: "stt.final",
      text: expect.stringContaining("turn 2"),
    });
    expect((await next(iterator)).value?.type).toBe("stt.endpoint");
  });

  it("uses deterministic audio windows for repeated continuous mock turns", async () => {
    const { stt } = createMockVoiceProviders();
    const stream = await stt.open(openRequest("continuous"));
    const iterator = stream.events[Symbol.asyncIterator]();

    for (let index = 1; index <= 50; index += 1) await stream.sendAudio(audioChunk(index));

    expect((await next(iterator)).value).toMatchObject({
      type: "stt.final",
      text: expect.stringContaining("turn 1"),
    });
    expect((await next(iterator)).value?.type).toBe("stt.endpoint");
    expect((await next(iterator)).value).toMatchObject({
      type: "stt.final",
      text: expect.stringContaining("turn 2"),
    });
  });

  it("emits a commit marker covering the mock audio chunk", async () => {
    const { tts } = createMockVoiceProviders();
    const stream = await tts.synthesize(ttsRequest());
    const events: TtsEvent[] = [];
    for await (const event of stream.events) events.push(event);

    expect(events.map((event) => event.type)).toEqual([
      "media.audio.chunk",
      "media.audio.committed",
    ]);
    const chunk = events[0];
    const committed = events[1];
    if (chunk?.type !== "media.audio.chunk" || committed?.type !== "media.audio.committed") {
      throw new Error("mock TTS did not emit the expected media events");
    }
    expect(committed.chunkIds).toEqual([chunk.id]);
    expect(committed.sequenceRange).toEqual([chunk.sequence, chunk.sequence]);
  });
});

function openRequest(mode: "push_to_talk" | "continuous"): SttOpenRequest {
  return {
    sessionId: "session_mock" as SessionId,
    format: PCM16_16K_MONO,
    interimResults: true,
    metadata: { voiceMode: mode },
  };
}

function audioChunk(sequence: number): InputAudioChunk {
  return {
    id: `mock_input_${sequence}` as never,
    type: "media.audio.chunk",
    sessionId: "session_mock" as SessionId,
    sequence,
    direction: "input",
    timestamp: nowTimestamp(),
    monotonicOffsetMs: sequence * 20,
    audio: {
      format: PCM16_16K_MONO,
      durationMs: 20,
      frameCount: 320,
      bytes: new Uint8Array(640),
    },
  };
}

function ttsRequest(): TtsSynthesisRequest {
  return {
    sessionId: "session_mock" as SessionId,
    turnId: "turn_mock" as never,
    format: PCM16_16K_MONO,
    text: "hello",
    stream: true,
  };
}

async function next<T>(iterator: AsyncIterator<T>): Promise<IteratorResult<T>> {
  return iterator.next();
}
