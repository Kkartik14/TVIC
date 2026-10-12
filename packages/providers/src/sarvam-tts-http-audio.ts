import { PROVIDER_NAMES } from "@tvic/core";

import { MAX_PROVIDER_TTS_OUTPUT_BYTES, providerEventQueueOverflow } from "./common.js";

export const SARVAM_TTS_HTTP_AUDIO_EVENT_CHUNK_BYTES = 1_024;

/** Coalesces transport fragments into aligned, bounded PCM output blocks. */
export class SarvamTtsHttpAudioChunker {
  #buffer = new Uint8Array(SARVAM_TTS_HTTP_AUDIO_EVENT_CHUNK_BYTES);
  #bufferedBytes = 0;
  #totalBytes = 0;

  push(bytes: Uint8Array): readonly Uint8Array[] {
    if (
      bytes.byteLength === 0 ||
      this.#totalBytes + bytes.byteLength > MAX_PROVIDER_TTS_OUTPUT_BYTES
    ) {
      throw providerEventQueueOverflow(PROVIDER_NAMES.sarvamTts);
    }
    this.#totalBytes += bytes.byteLength;

    const chunks: Uint8Array[] = [];
    let offset = 0;
    while (offset < bytes.byteLength) {
      const bytesToCopy = Math.min(
        SARVAM_TTS_HTTP_AUDIO_EVENT_CHUNK_BYTES - this.#bufferedBytes,
        bytes.byteLength - offset,
      );
      this.#buffer.set(bytes.subarray(offset, offset + bytesToCopy), this.#bufferedBytes);
      this.#bufferedBytes += bytesToCopy;
      offset += bytesToCopy;
      if (this.#bufferedBytes === SARVAM_TTS_HTTP_AUDIO_EVENT_CHUNK_BYTES) {
        chunks.push(this.#buffer);
        this.#buffer = new Uint8Array(SARVAM_TTS_HTTP_AUDIO_EVENT_CHUNK_BYTES);
        this.#bufferedBytes = 0;
      }
    }
    return chunks;
  }

  finish(): readonly Uint8Array[] {
    if (this.#bufferedBytes === 0) return [];
    if (this.#bufferedBytes % 2 !== 0) {
      throw providerEventQueueOverflow(PROVIDER_NAMES.sarvamTts);
    }
    const chunk = this.#buffer.subarray(0, this.#bufferedBytes);
    this.#buffer = new Uint8Array(SARVAM_TTS_HTTP_AUDIO_EVENT_CHUNK_BYTES);
    this.#bufferedBytes = 0;
    return [chunk];
  }
}
