import { MAX_PROVIDER_TTS_OUTPUT_BYTES } from "./common.js";

const SARVAM_TTS_WAV_HEADER_MAX_BYTES = 64 * 1024;

/** Incrementally decodes Sarvam's 16 kHz mono PCM WAV response. */
export class SarvamWavStreamDecoder {
  #buffer = Buffer.alloc(0);
  #headerParsed = false;
  #dataRemaining: number | undefined;
  #pendingByte: number | undefined;
  #totalData = 0;

  push(chunk: Uint8Array): readonly Uint8Array[] {
    if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) return [];
    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
    if (!this.#headerParsed) this.#parseHeader();
    return this.#takeData();
  }

  finish(): void {
    if (!this.#headerParsed) throw new Error("truncated WAV header");
    if (this.#dataRemaining !== undefined && this.#dataRemaining !== 0) {
      throw new Error("truncated WAV data");
    }
    if (this.#pendingByte !== undefined || this.#totalData === 0) {
      throw new Error("invalid WAV PCM data");
    }
  }

  #parseHeader(): void {
    if (this.#buffer.byteLength < 12) return;
    if (
      this.#buffer.toString("ascii", 0, 4) !== "RIFF" ||
      this.#buffer.toString("ascii", 8, 12) !== "WAVE"
    ) {
      throw new Error("Sarvam HTTP stream did not return RIFF/WAVE audio");
    }

    let offset = 12;
    let fmt:
      | {
          readonly format: number;
          readonly channels: number;
          readonly rate: number;
          readonly bits: number;
        }
      | undefined;
    while (true) {
      if (offset > SARVAM_TTS_WAV_HEADER_MAX_BYTES) {
        throw new Error("Sarvam WAV header exceeded the size limit");
      }
      if (this.#buffer.byteLength < offset + 8) return;
      const chunkId = this.#buffer.toString("ascii", offset, offset + 4);
      const chunkLength = this.#buffer.readUInt32LE(offset + 4);
      const chunkStart = offset + 8;
      if (chunkId === "data") {
        if (
          !fmt ||
          fmt.format !== 1 ||
          fmt.channels !== 1 ||
          fmt.rate !== 16_000 ||
          fmt.bits !== 16
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
        this.#buffer = this.#buffer.subarray(chunkStart);
        return;
      }
      const chunkEnd = chunkStart + chunkLength;
      const paddedEnd = chunkEnd + (chunkLength % 2);
      if (!Number.isSafeInteger(paddedEnd) || paddedEnd > SARVAM_TTS_WAV_HEADER_MAX_BYTES) {
        throw new Error("Sarvam WAV header chunk is too large");
      }
      if (this.#buffer.byteLength < paddedEnd) return;

      if (chunkId === "fmt ") {
        if (chunkLength < 16) throw new Error("Sarvam WAV fmt chunk is invalid");
        fmt = {
          format: this.#buffer.readUInt16LE(chunkStart),
          channels: this.#buffer.readUInt16LE(chunkStart + 2),
          rate: this.#buffer.readUInt32LE(chunkStart + 4),
          bits: this.#buffer.readUInt16LE(chunkStart + 14),
        };
      }
      offset = paddedEnd;
    }
  }

  #takeData(): readonly Uint8Array[] {
    if (!this.#headerParsed || this.#dataRemaining === 0 || this.#buffer.byteLength === 0) {
      return [];
    }
    const take =
      this.#dataRemaining === undefined
        ? this.#buffer.byteLength
        : Math.min(this.#dataRemaining, this.#buffer.byteLength);
    const incoming = this.#buffer.subarray(0, take);
    this.#buffer = this.#buffer.subarray(take);
    if (this.#dataRemaining !== undefined) this.#dataRemaining -= take;
    this.#totalData += take;
    if (this.#totalData > MAX_PROVIDER_TTS_OUTPUT_BYTES) {
      throw new Error("Sarvam WAV output exceeded the size limit");
    }

    let bytes =
      this.#pendingByte === undefined
        ? Buffer.from(incoming)
        : Buffer.concat([Buffer.from([this.#pendingByte]), Buffer.from(incoming)]);
    this.#pendingByte = undefined;
    if (bytes.byteLength % 2 !== 0) {
      this.#pendingByte = bytes[bytes.byteLength - 1];
      bytes = bytes.subarray(0, bytes.byteLength - 1);
    }
    return bytes.byteLength > 0 ? [new Uint8Array(bytes)] : [];
  }
}
