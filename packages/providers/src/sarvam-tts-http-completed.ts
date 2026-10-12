import { PROVIDER_NAMES, counterIdGenerator, createMediaEvent } from "@tvic/core";
import type { MediaEventId, TtsEvent, TtsStream, TtsSynthesisRequest } from "@tvic/core";
import { AsyncQueue, durationMsForPcm16le, frameCountForPcm16le } from "@tvic/media";

import { MAX_PROVIDER_TTS_OUTPUT_BYTES, type ProviderClock } from "./common.js";

const SARVAM_TTS_REST_AUDIO_EVENT_CHUNK_BYTES = 32 * 1024;
const SARVAM_TTS_REST_MAX_AUDIO_EVENTS = Math.ceil(
  MAX_PROVIDER_TTS_OUTPUT_BYTES / SARVAM_TTS_REST_AUDIO_EVENT_CHUNK_BYTES,
);

interface SarvamTtsCompletedStreamOptions {
  readonly clock: ProviderClock;
  readonly model: string;
  readonly language: string;
  readonly voice: string;
  readonly transport: "rest";
  readonly wireFormat: "linear16" | "wav";
  readonly requestId?: string;
  readonly audio: Uint8Array;
}

export class SarvamTtsCompletedStream implements TtsStream {
  readonly events: AsyncIterable<TtsEvent>;
  readonly #events = new AsyncQueue<TtsEvent>({
    maxBuffered: SARVAM_TTS_REST_MAX_AUDIO_EVENTS + 1,
  });
  #closed = false;

  constructor(request: TtsSynthesisRequest, options: SarvamTtsCompletedStreamOptions) {
    this.events = this.#events;
    const ids = counterIdGenerator<MediaEventId>(
      `sarvam_tts_rest_${String(request.sessionId)}_${String(request.turnId)}`,
    );
    const chunkIds: MediaEventId[] = [];
    const totalFrames = frameCountForPcm16le(options.audio);
    for (
      let offset = 0;
      offset < options.audio.byteLength;
      offset += SARVAM_TTS_REST_AUDIO_EVENT_CHUNK_BYTES
    ) {
      const end = Math.min(
        offset + SARVAM_TTS_REST_AUDIO_EVENT_CHUNK_BYTES,
        options.audio.byteLength,
      );
      const audioBytes = options.audio.subarray(offset, end);
      const sequence = chunkIds.length + 1;
      const chunkId = `${ids.next()}_chunk_${options.clock.now()}` as MediaEventId;
      chunkIds.push(chunkId);
      this.#events.push(
        createMediaEvent({
          id: chunkId,
          type: "media.audio.chunk",
          sessionId: request.sessionId,
          turnId: request.turnId,
          sequence,
          direction: "output",
          timestamp: options.clock.now(),
          monotonicOffsetMs: 0,
          provider: PROVIDER_NAMES.sarvamTts,
          audio: {
            format: request.format,
            durationMs: durationMsForPcm16le(audioBytes, request.format.sampleRateHz),
            frameCount: frameCountForPcm16le(audioBytes),
            bytes: new Uint8Array(audioBytes),
          },
          metadata: {
            sarvam: {
              transport: options.transport,
              wireFormat: options.wireFormat,
              model: options.model,
              language: options.language,
              voice: options.voice,
              ...(options.requestId ? { requestId: options.requestId } : {}),
            },
          },
        }),
      );
    }
    const commitSequence = chunkIds.length + 1;
    this.#events.push(
      createMediaEvent({
        id: `${ids.next()}_committed_${options.clock.now()}` as MediaEventId,
        type: "media.audio.committed",
        sessionId: request.sessionId,
        turnId: request.turnId,
        sequence: commitSequence,
        direction: "output",
        timestamp: options.clock.now(),
        monotonicOffsetMs: 0,
        provider: PROVIDER_NAMES.sarvamTts,
        durationMs: durationMsForPcm16le(options.audio, request.format.sampleRateHz),
        frameCount: totalFrames,
        sequenceRange: [1, chunkIds.length],
        chunkIds,
        metadata: {
          sarvam: {
            transport: options.transport,
            wireFormat: options.wireFormat,
            model: options.model,
            language: options.language,
            voice: options.voice,
            ...(options.requestId ? { requestId: options.requestId } : {}),
          },
        },
      }),
    );
    this.#events.close();
  }

  async cancel(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#events.close();
  }
}
