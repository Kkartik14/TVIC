import { MAX_PROVIDER_TTS_OUTPUT_BYTES } from "./common.js";

const SARVAM_TTS_WAV_HEADER_MAX_BYTES = 64 * 1024;

interface SarvamWavFormat {
  readonly format: number;
  readonly channels: number;
  readonly rate: number;
  readonly bits: number;
}

/** Incrementally decodes Sarvam's 16 kHz mono PCM WAV response. */
export class SarvamWavStreamDecoder {
  #buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  #bufferLength = 0;
  #headerOffset = 12;
  #format: SarvamWavFormat | undefined;
  #headerParsed = false;
  #dataRemaining: number | undefined;
  #totalData = 0;

  get isComplete(): boolean {
    return this.#dataRemaining === 0;
  }

  push(chunk: Uint8Array): readonly Uint8Array[] {
    if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) return [];
    if (this.#dataRemaining === 0) return [];
    if (this.#headerParsed) {
      this.#appendDataChunk(chunk);
    } else {
      const remainingHeaderBytes = SARVAM_TTS_WAV_HEADER_MAX_BYTES - this.#bufferLength;
      const headerBytes = chunk.subarray(0, Math.max(0, remainingHeaderBytes));
      this.#appendHeaderChunk(headerBytes);
      this.#parseHeader();
      if (!this.#headerParsed && headerBytes.byteLength < chunk.byteLength) {
        throw new Error("Sarvam WAV header exceeded the size limit");
      }
      if (this.#headerParsed && headerBytes.byteLength < chunk.byteLength) {
        this.#appendDataChunk(chunk.subarray(headerBytes.byteLength));
      }
    }
    const audio = this.#takeData();
    if (this.#dataRemaining === 0) {
      // Trust the declared data size; ignore untrusted trailing bytes.
      this.#buffer = Buffer.alloc(0);
      this.#bufferLength = 0;
    }
    return audio;
  }

  finish(): void {
    if (!this.#headerParsed) throw new Error("truncated WAV header");
    if (this.#dataRemaining !== undefined && this.#dataRemaining !== 0) {
      throw new Error("truncated WAV data");
    }
    if (this.#totalData === 0 || this.#totalData % 2 !== 0) {
      throw new Error("invalid WAV PCM data");
    }
  }

  #parseHeader(): void {
    if (this.#bufferLength < 12) return;
    if (
      this.#buffer.toString("ascii", 0, 4) !== "RIFF" ||
      this.#buffer.toString("ascii", 8, 12) !== "WAVE"
    ) {
      throw new Error("Sarvam HTTP stream did not return RIFF/WAVE audio");
    }

    let offset = this.#headerOffset;
    while (true) {
      if (offset > SARVAM_TTS_WAV_HEADER_MAX_BYTES) {
        throw new Error("Sarvam WAV header exceeded the size limit");
      }
      if (this.#bufferLength < offset + 8) return;
      const chunkId = this.#buffer.toString("ascii", offset, offset + 4);
      const chunkLength = this.#buffer.readUInt32LE(offset + 4);
      const chunkStart = offset + 8;
      if (chunkId === "data") {
        if (
          !this.#format ||
          this.#format.format !== 1 ||
          this.#format.channels !== 1 ||
          this.#format.rate !== 16_000 ||
          this.#format.bits !== 16
        ) {
          throw new Error("Sarvam WAV stream is not 16kHz mono PCM16");
        }
        if (chunkLength === 0 || (chunkLength !== 0xffff_ffff && chunkLength % 2 !== 0)) {
          throw new Error("Sarvam WAV data length is invalid");
        }
        this.#dataRemaining = chunkLength === 0xffff_ffff ? undefined : chunkLength;
        if (
          this.#dataRemaining !== undefined &&
          this.#dataRemaining > MAX_PROVIDER_TTS_OUTPUT_BYTES
        ) {
          throw new Error("Sarvam WAV data length is invalid");
        }
        this.#headerParsed = true;
        const availableDataBytes = this.#bufferLength - chunkStart;
        const maxBufferedDataBytes =
          this.#dataRemaining ?? MAX_PROVIDER_TTS_OUTPUT_BYTES - this.#totalData;
        if (this.#dataRemaining === undefined && availableDataBytes > maxBufferedDataBytes) {
          throw new Error("Sarvam WAV output exceeded the size limit");
        }
        const bufferedDataBytes = Math.min(availableDataBytes, maxBufferedDataBytes);
        this.#buffer = Buffer.from(
          this.#buffer.subarray(chunkStart, chunkStart + bufferedDataBytes),
        );
        this.#bufferLength = this.#buffer.byteLength;
        return;
      }
      const chunkEnd = chunkStart + chunkLength;
      const paddedEnd = chunkEnd + (chunkLength % 2);
      if (!Number.isSafeInteger(paddedEnd) || paddedEnd > SARVAM_TTS_WAV_HEADER_MAX_BYTES) {
        throw new Error("Sarvam WAV header chunk is too large");
      }
      if (this.#bufferLength < paddedEnd) return;

      if (chunkId === "fmt ") {
        if (chunkLength < 16) throw new Error("Sarvam WAV fmt chunk is invalid");
        this.#format = {
          format: this.#buffer.readUInt16LE(chunkStart),
          channels: this.#buffer.readUInt16LE(chunkStart + 2),
          rate: this.#buffer.readUInt32LE(chunkStart + 4),
          bits: this.#buffer.readUInt16LE(chunkStart + 14),
        };
      }
      offset = paddedEnd;
      this.#headerOffset = offset;
    }
  }

  #takeData(): readonly Uint8Array[] {
    if (!this.#headerParsed || this.#dataRemaining === 0 || this.#bufferLength === 0) {
      return [];
    }
    const take =
      this.#dataRemaining === undefined
        ? this.#bufferLength
        : Math.min(this.#dataRemaining, this.#bufferLength);
    const incoming = this.#buffer.subarray(0, take);
    this.#buffer = this.#buffer.subarray(take);
    this.#bufferLength -= take;
    if (this.#dataRemaining !== undefined) this.#dataRemaining -= take;
    this.#totalData += take;
    if (this.#totalData > MAX_PROVIDER_TTS_OUTPUT_BYTES) {
      throw new Error("Sarvam WAV output exceeded the size limit");
    }

    return incoming.byteLength > 0 ? [incoming] : [];
  }

  #appendHeaderChunk(chunk: Uint8Array): void {
    const required = this.#bufferLength + chunk.byteLength;
    if (required > this.#buffer.byteLength) {
      const capacity = Math.max(required, Math.max(64, this.#buffer.byteLength * 2));
      const next = Buffer.allocUnsafe(capacity);
      this.#buffer.copy(next, 0, 0, this.#bufferLength);
      this.#buffer = next;
    }
    Buffer.from(chunk).copy(this.#buffer, this.#bufferLength);
    this.#bufferLength = required;
  }

  #appendDataChunk(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    const maxAppendBytes =
      this.#dataRemaining === undefined
        ? MAX_PROVIDER_TTS_OUTPUT_BYTES - this.#totalData - this.#bufferLength
        : this.#dataRemaining - this.#bufferLength;
    const appendBytes = Math.min(chunk.byteLength, maxAppendBytes);
    if (this.#dataRemaining === undefined && appendBytes < chunk.byteLength) {
      throw new Error("Sarvam WAV output exceeded the size limit");
    }
    if (appendBytes <= 0) return;

    // The HTTP stream consumes these views synchronously through the PCM chunker.
    const boundedChunk = Buffer.from(chunk.buffer, chunk.byteOffset, appendBytes);
    this.#buffer =
      this.#bufferLength === 0
        ? boundedChunk
        : Buffer.concat([this.#buffer, boundedChunk], this.#bufferLength + appendBytes);
    this.#bufferLength += appendBytes;
  }
}
