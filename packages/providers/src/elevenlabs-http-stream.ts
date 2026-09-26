import {
  PROVIDER_ERROR_CODES,
  PROVIDER_NAMES,
  counterIdGenerator,
  createMediaEvent,
} from "@tvic/core";
import type {
  CounterIdGenerator,
  MediaAudioCommittedEvent,
  MediaEventId,
  TtsAlignmentEvent,
  TtsEvent,
  TtsStream,
} from "@tvic/core";
import { AsyncQueue, durationMsForPcm16le, frameCountForPcm16le } from "@tvic/media";

import {
  MAX_PROVIDER_TTS_OUTPUT_BYTES,
  MAX_PROVIDER_TTS_OUTPUT_CHUNKS,
  providerEventQueueOverflow,
  providerThrowableError,
  type ProviderClock,
} from "./common.js";
import {
  decodeBase64Pcm,
  elevenLabsProtocolError,
  parseHttpAlignment,
  JsonObjectAccumulator,
  type ParsedHttpAlignment,
} from "./elevenlabs-http-helpers.js";
import type { ElevenLabsOutputRequest } from "./elevenlabs-http.js";

export interface ElevenLabsStreamOptions {
  readonly clock: ProviderClock;
  readonly controller: AbortController;
  readonly detachAbort: () => void;
  readonly model: string;
  readonly protocol: "tts" | "dialogue";
  readonly voice: string;
  readonly timestamped: boolean;
}

export class ElevenLabsHttpStream implements TtsStream {
  readonly events: AsyncIterable<TtsEvent>;
  readonly #events = new AsyncQueue<TtsEvent>({
    onOverflow: () => {
      const error = providerEventQueueOverflow(PROVIDER_NAMES.elevenlabs);
      this.#fail(error);
      return error;
    },
  });
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #request: ElevenLabsOutputRequest;
  readonly #options: ElevenLabsStreamOptions;
  readonly #mediaIds: CounterIdGenerator<MediaEventId>;
  readonly #json = new JsonObjectAccumulator();
  readonly #chunkIds: MediaEventId[] = [];
  readonly #chunkSequences: number[] = [];
  #mediaSequence = 1;
  #closed = false;
  #cancelled = false;
  #outputBytes = 0;
  #outputChunks = 0;
  #frameCount = 0;
  #sawAudio = false;

  constructor(
    body: ReadableStream<Uint8Array>,
    request: ElevenLabsOutputRequest,
    options: ElevenLabsStreamOptions,
  ) {
    this.#reader = body.getReader();
    this.#request = request;
    this.#options = options;
    this.#mediaIds = counterIdGenerator<MediaEventId>(
      `elevenlabs_http_${String(request.sessionId)}_${String(request.turnId)}`,
    );
    this.events = this.#events;
  }

  start(): void {
    void this.#pump();
  }

  async cancel(): Promise<void> {
    if (this.#closed) return;
    this.#cancelled = true;
    this.#options.controller.abort();
    await this.#reader.cancel().catch(() => undefined);
    this.#close();
  }

  async #pump(): Promise<void> {
    try {
      while (!this.#closed) {
        const result = await this.#reader.read();
        if (result.done) break;
        if (this.#options.timestamped) {
          for (const value of this.#json.push(result.value)) this.#handleTimedValue(value);
        } else {
          this.#pushPcm(result.value);
        }
      }
      if (this.#options.timestamped) {
        for (const value of this.#json.finish()) this.#handleTimedValue(value);
      } else {
        this.#flushPcmRemainder();
      }
      if (!this.#sawAudio) throw elevenLabsProtocolError("ElevenLabs returned no audio data");
      if (this.#closed) return;
      this.#pushCommittedEvent();
      this.#close();
    } catch (error) {
      if (this.#cancelled || this.#options.controller.signal.aborted) {
        this.#close();
        return;
      }
      this.#fail(error);
    }
  }

  #handleTimedValue(value: Readonly<Record<string, unknown>>): void {
    const audio = value.audio_base64;
    if (typeof audio !== "string") {
      throw elevenLabsProtocolError("ElevenLabs timed stream returned no audio_base64 field");
    }
    this.#pushPcm(decodeBase64Pcm(audio));
    const alignment = parseHttpAlignment(value.alignment ?? value.normalized_alignment);
    if (alignment) this.#pushAlignment(alignment);
  }

  #pushPcm(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    const combined = new Uint8Array(this.#pendingPcm.byteLength + bytes.byteLength);
    combined.set(this.#pendingPcm);
    combined.set(bytes, this.#pendingPcm.byteLength);
    const completeBytes = combined.byteLength - (combined.byteLength % 2);
    if (completeBytes > 0) this.#emitAudio(combined.slice(0, completeBytes));
    this.#pendingPcm = combined.slice(completeBytes);
  }

  #pendingPcm = new Uint8Array();

  #flushPcmRemainder(): void {
    if (this.#pendingPcm.byteLength !== 0) {
      throw elevenLabsProtocolError("ElevenLabs returned an incomplete PCM16 sample");
    }
  }

  #emitAudio(bytes: Uint8Array): void {
    if (
      bytes.byteLength === 0 ||
      this.#outputChunks >= MAX_PROVIDER_TTS_OUTPUT_CHUNKS ||
      this.#outputBytes + bytes.byteLength > MAX_PROVIDER_TTS_OUTPUT_BYTES
    ) {
      throw providerEventQueueOverflow(PROVIDER_NAMES.elevenlabs);
    }
    this.#sawAudio = true;
    const id = this.#mediaId("chunk");
    const frames = frameCountForPcm16le(bytes);
    const event = createMediaEvent({
      id,
      type: "media.audio.chunk",
      sessionId: this.#request.sessionId,
      turnId: this.#request.turnId,
      sequence: this.#mediaSequence,
      direction: "output",
      timestamp: this.#options.clock.now(),
      monotonicOffsetMs: 0,
      provider: PROVIDER_NAMES.elevenlabs,
      audio: {
        format: this.#request.format,
        durationMs: durationMsForPcm16le(bytes, this.#request.format.sampleRateHz),
        frameCount: frames,
        bytes: new Uint8Array(bytes),
      },
      metadata: {
        elevenlabs: {
          transport: "http-stream",
          protocol: this.#options.protocol,
          model: this.#options.model,
          voice: this.#options.voice,
          timestamped: this.#options.timestamped,
        },
      },
    });
    if (!this.#pushEvent(event)) return;
    this.#chunkIds.push(id);
    this.#chunkSequences.push(this.#mediaSequence);
    this.#mediaSequence += 1;
    this.#frameCount += frames;
    this.#outputBytes += bytes.byteLength;
    this.#outputChunks += 1;
  }

  #pushAlignment(alignment: ParsedHttpAlignment): void {
    const event: TtsAlignmentEvent = {
      type: "tts.alignment",
      sessionId: this.#request.sessionId,
      turnId: this.#request.turnId,
      sequence: this.#mediaSequence,
      provider: PROVIDER_NAMES.elevenlabs,
      timestamp: this.#options.clock.now(),
      unit: "character",
      tokens: alignment.tokens,
      startMs: alignment.startMs,
      endMs: alignment.endMs,
    };
    if (this.#pushEvent(event)) this.#mediaSequence += 1;
  }

  #pushCommittedEvent(): void {
    const event: MediaAudioCommittedEvent = createMediaEvent({
      id: this.#mediaId("committed"),
      type: "media.audio.committed",
      sessionId: this.#request.sessionId,
      turnId: this.#request.turnId,
      sequence: this.#mediaSequence,
      direction: "output",
      timestamp: this.#options.clock.now(),
      monotonicOffsetMs: 0,
      provider: PROVIDER_NAMES.elevenlabs,
      durationMs: (this.#frameCount / this.#request.format.sampleRateHz) * 1_000,
      frameCount: this.#frameCount,
      sequenceRange: [this.#chunkSequences[0] ?? 0, this.#chunkSequences.at(-1) ?? 0],
      chunkIds: [...this.#chunkIds],
      metadata: {
        elevenlabs: {
          transport: "http-stream",
          protocol: this.#options.protocol,
          model: this.#options.model,
          voice: this.#options.voice,
          timestamped: this.#options.timestamped,
        },
      },
    });
    this.#pushEvent(event);
  }

  #mediaId(kind: string): MediaEventId {
    return `${this.#mediaIds.next()}_${kind}_${this.#options.clock.now()}` as MediaEventId;
  }

  #pushEvent(event: TtsEvent): boolean {
    if (this.#events.push(event)) return true;
    this.#fail(providerEventQueueOverflow(PROVIDER_NAMES.elevenlabs));
    return false;
  }

  #close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#options.detachAbort();
    this.#events.close();
  }

  #fail(error: unknown): void {
    if (this.#closed) return;
    const throwable = providerThrowableError(error, {
      code: PROVIDER_ERROR_CODES.elevenlabsTts,
      provider: PROVIDER_NAMES.elevenlabs,
    });
    this.#closed = true;
    this.#options.detachAbort();
    this.#options.controller.abort(throwable);
    void this.#reader.cancel().catch(() => undefined);
    this.#events.fail(throwable);
  }
}

export interface CompletedStreamOptions {
  readonly clock: ProviderClock;
  readonly model: string;
  readonly protocol: "tts" | "dialogue";
  readonly voice: string;
  readonly audio: Uint8Array;
  readonly alignment?: ParsedHttpAlignment;
}

export class ElevenLabsCompletedStream implements TtsStream {
  readonly events: AsyncIterable<TtsEvent>;
  readonly #events = new AsyncQueue<TtsEvent>();
  #closed = false;

  constructor(request: ElevenLabsOutputRequest, options: CompletedStreamOptions) {
    this.events = this.#events;
    const ids = counterIdGenerator<MediaEventId>(
      `elevenlabs_http_${String(request.sessionId)}_${String(request.turnId)}`,
    );
    const chunkId = `${ids.next()}_chunk_${options.clock.now()}` as MediaEventId;
    const frames = frameCountForPcm16le(options.audio);
    const metadata = {
      elevenlabs: {
        transport: "rest",
        protocol: options.protocol,
        model: options.model,
        voice: options.voice,
      },
    } as const;
    this.#events.push(
      createMediaEvent({
        id: chunkId,
        type: "media.audio.chunk",
        sessionId: request.sessionId,
        turnId: request.turnId,
        sequence: 1,
        direction: "output",
        timestamp: options.clock.now(),
        monotonicOffsetMs: 0,
        provider: PROVIDER_NAMES.elevenlabs,
        audio: {
          format: request.format,
          durationMs: durationMsForPcm16le(options.audio, request.format.sampleRateHz),
          frameCount: frames,
          bytes: new Uint8Array(options.audio),
        },
        metadata,
      }),
    );
    if (options.alignment) {
      this.#events.push({
        type: "tts.alignment",
        sessionId: request.sessionId,
        turnId: request.turnId,
        sequence: 2,
        provider: PROVIDER_NAMES.elevenlabs,
        timestamp: options.clock.now(),
        unit: "character",
        tokens: options.alignment.tokens,
        startMs: options.alignment.startMs,
        endMs: options.alignment.endMs,
      });
    }
    this.#events.push(
      createMediaEvent({
        id: `${ids.next()}_committed_${options.clock.now()}` as MediaEventId,
        type: "media.audio.committed",
        sessionId: request.sessionId,
        turnId: request.turnId,
        sequence: options.alignment ? 3 : 2,
        direction: "output",
        timestamp: options.clock.now(),
        monotonicOffsetMs: 0,
        provider: PROVIDER_NAMES.elevenlabs,
        durationMs: durationMsForPcm16le(options.audio, request.format.sampleRateHz),
        frameCount: frames,
        sequenceRange: [1, 1],
        chunkIds: [chunkId],
        metadata,
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
