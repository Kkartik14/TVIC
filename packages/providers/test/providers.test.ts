import WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";

import type { SessionId, TelephonyProvider, Timestamp, TurnId } from "@tvic/core";
import {
  PCM16_16K_MONO,
  PROVIDER_ERROR_CODES,
  PROVIDER_NAMES,
  STT_ERROR_CODES,
  TVIC_ERROR_CODES,
  isIncrementalTextToSpeechProvider,
} from "@tvic/core";
import { AsyncQueue } from "@tvic/media";

import {
  AssemblyAiSttProvider,
  AssemblyAiSttStream,
  ElevenLabsSttProvider,
  ElevenLabsSttStream,
  CartesiaTtsProvider,
  CartesiaTtsStream,
  DeepgramSttProvider,
  DeepgramSttStream,
  MAX_CARTESIA_INPUT_UTF16_CODE_UNITS,
  MAX_CARTESIA_INPUT_UTF8_BYTES,
  OpenAiResponsesLlmProvider,
  SarvamSttProvider,
  SarvamSttStream,
  SonioxSttProvider,
  SonioxSttStream,
  requireProviderKind,
  supportsAudioFormat,
} from "../src/index.js";
import { PROVIDER_CATALOG } from "../src/catalog.js";
import { cartesiaProviderError } from "../src/cartesia.js";
import {
  MAX_PROVIDER_TTS_OUTPUT_BYTES,
  PROVIDER_OUTBOUND_HARD_LIMIT_BYTES,
  PROVIDER_OUTBOUND_HIGH_WATER_BYTES,
  providerSendCapacity,
  rawDataByteLength,
  rawDataToBuffer,
  safeClose,
  safeSend,
} from "../src/common.js";

const provider: TelephonyProvider = {
  name: "telephony-contract-provider",
  kind: "telephony",
  version: "0.1.0",
  capabilities: {
    streaming: { input: true, output: true, native: true },
    cancellation: { request: true, output: true, buffer: true, truncation: false },
    transports: ["websocket"],
    audio: { input: [PCM16_16K_MONO], output: [PCM16_16K_MONO] },
  },
  async dial() {
    throw new Error("not used");
  },
  async accept() {
    throw new Error("not used");
  },
  async hangup() {
    return;
  },
};

describe("provider utilities", () => {
  it("bounds fragmented RawData before concatenating it", () => {
    const chunks = [Buffer.from("hello"), Buffer.from(" world")];
    expect(rawDataByteLength(chunks)).toBe(11);
    expect(rawDataToBuffer(chunks).toString("utf8")).toBe("hello world");
    expect(() => rawDataToBuffer(chunks, 10)).toThrow(/exceeded 10 bytes/);
  });

  it("narrows providers by kind", () => {
    expect(requireProviderKind(provider, "telephony")).toBe(provider);
  });

  it("reports a throwable validation error for a provider-kind mismatch", () => {
    let thrown: unknown;
    try {
      requireProviderKind(provider, "stt");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      name: "ValidationError",
      code: "provider.kind_mismatch",
      category: "validation",
    });
  });

  it("checks normalized audio format support", () => {
    expect(supportsAudioFormat(provider, PCM16_16K_MONO, "input")).toBe(true);
    expect(supportsAudioFormat(provider, PCM16_16K_MONO, "output")).toBe(true);
  });

  it("identifies providers with native incremental TTS sessions", () => {
    const cartesia = new CartesiaTtsProvider({ apiKey: "test", voiceId: "voice" });
    expect(isIncrementalTextToSpeechProvider(cartesia)).toBe(true);
    expect(
      isIncrementalTextToSpeechProvider({ ...cartesia, openSession: undefined } as never),
    ).toBe(false);
  });

  it("classifies Cartesia authentication, validation, and transient errors", () => {
    expect(cartesiaProviderError({ type: "error", error_code: "invalid_api_key" })).toMatchObject({
      code: TVIC_ERROR_CODES.providerAuthFailed,
      retriable: false,
      metadata: { providerCode: "invalid_api_key", classification: "auth" },
    });
    expect(
      cartesiaProviderError({ type: "error", error_code: "rate_limit_exceeded" }),
    ).toMatchObject({
      code: TVIC_ERROR_CODES.providerRateLimited,
      retriable: true,
      metadata: { providerCode: "rate_limit_exceeded", classification: "rate_limited" },
    });
  });

  it("rejects an awaiting AsyncQueue consumer on fail", async () => {
    const queue = new AsyncQueue<number>();
    const iterator = queue[Symbol.asyncIterator]();
    const pending = iterator.next();
    const error = new Error("provider failed");

    queue.fail(error);

    await expect(pending).rejects.toBe(error);
    await expect(iterator.next()).rejects.toBe(error);
  });

  it("preserves even undefined as an AsyncQueue failure value", async () => {
    const queue = new AsyncQueue<number>();
    const iterator = queue[Symbol.asyncIterator]();
    const pending = iterator.next();

    queue.fail(undefined);

    await expect(pending).rejects.toBeUndefined();
    await expect(iterator.next()).rejects.toBeUndefined();
  });

  it("separates Deepgram final segments from conversational endpoints", async () => {
    const socket = new FakeSocket();
    const stream = new DeepgramSttStream(
      socket as never,
      {
        sessionId: "session_deepgram" as SessionId,
        format: PCM16_16K_MONO,
        interimResults: true,
      },
      fixedClock,
    );
    const iterator = stream.events[Symbol.asyncIterator]();

    socket.receive(JSON.stringify({ type: "SpeechStarted", timestamp: 0 }));
    const speechStarted = await iterator.next();
    expect(speechStarted.value).toEqual(
      expect.objectContaining({ type: "stt.speech.started", audioOffsetMs: 0, sequence: 1 }),
    );

    socket.receive(
      JSON.stringify({
        type: "Results",
        is_final: true,
        speech_final: false,
        start: 0,
        duration: 0.4,
        channel: {
          alternatives: [{ transcript: "hello", confidence: 0.91, languages: ["en"] }],
        },
      }),
    );

    const firstSegment = await iterator.next();
    expect(firstSegment.value).toEqual(
      expect.objectContaining({
        type: "stt.final",
        text: "hello",
        confidence: 0.91,
        language: "en",
        provider: "deepgram",
        sequence: 2,
        audioStartMs: 0,
        audioEndMs: 400,
      }),
    );

    socket.receive(
      JSON.stringify({
        type: "Results",
        is_final: true,
        speech_final: true,
        start: 0.4,
        duration: 0.3,
        channel: { alternatives: [{ transcript: "there", confidence: 0.9 }] },
      }),
    );

    const finalSegment = await iterator.next();
    const endpoint = await iterator.next();
    expect(finalSegment.value).toEqual(
      expect.objectContaining({ type: "stt.final", text: "there", sequence: 3 }),
    );
    expect(endpoint.value).toEqual(
      expect.objectContaining({
        type: "stt.endpoint",
        reason: "provider",
        sequence: 4,
        audioOffsetMs: 700,
      }),
    );
    const closing = stream.close();
    socket.close();
    await closing;
  });

  it("fails closed on malformed Deepgram Results envelopes", async () => {
    const socket = new FakeSocket();
    const stream = new DeepgramSttStream(
      socket as never,
      {
        sessionId: "session_deepgram_malformed_results" as SessionId,
        format: PCM16_16K_MONO,
        interimResults: true,
      },
      fixedClock,
    );
    const pending = stream.events[Symbol.asyncIterator]().next();

    socket.receive(JSON.stringify({ type: "Results", channel: {} }));

    await expect(pending).rejects.toMatchObject({
      code: STT_ERROR_CODES.protocolError,
      provider: PROVIDER_NAMES.deepgram,
      retriable: false,
    });
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("treats empty Deepgram Results alternatives as an explicit bounded no-op", async () => {
    const socket = new FakeSocket();
    const stream = new DeepgramSttStream(
      socket as never,
      {
        sessionId: "session_deepgram_empty_results" as SessionId,
        format: PCM16_16K_MONO,
        interimResults: true,
      },
      fixedClock,
    );
    const iterator = stream.events[Symbol.asyncIterator]();
    const nextEvent = iterator.next();

    socket.receive(JSON.stringify({ type: "Results", channel: { alternatives: [] } }));
    socket.receive(
      JSON.stringify({
        type: "Results",
        is_final: true,
        speech_final: true,
        channel: { alternatives: [] },
      }),
    );
    socket.receive(JSON.stringify({ type: "SpeechStarted", timestamp: 0 }));

    await expect(nextEvent).resolves.toMatchObject({
      value: { type: "stt.speech.started", sequence: 1 },
      done: false,
    });
    const closing = stream.close();
    socket.close();
    await closing;
  });

  it("rejects Deepgram timing beyond the one-day offset bound", async () => {
    const socket = new FakeSocket();
    const stream = new DeepgramSttStream(
      socket as never,
      {
        sessionId: "session_deepgram_timestamp_bound" as SessionId,
        format: PCM16_16K_MONO,
        interimResults: true,
      },
      fixedClock,
    );
    const pending = stream.events[Symbol.asyncIterator]().next();

    socket.receive(
      JSON.stringify({
        type: "Results",
        start: 86_400.001,
        duration: 0,
        channel: { alternatives: [{ transcript: "invalid" }] },
      }),
    );

    await expect(pending).rejects.toMatchObject({
      code: STT_ERROR_CODES.protocolError,
      provider: PROVIDER_NAMES.deepgram,
    });
  });

  it("fails closed on an unknown Deepgram message type", async () => {
    const socket = new FakeSocket();
    const stream = new DeepgramSttStream(
      socket as never,
      {
        sessionId: "session_deepgram_unknown_type" as SessionId,
        format: PCM16_16K_MONO,
        interimResults: true,
      },
      fixedClock,
    );
    const pending = stream.events[Symbol.asyncIterator]().next();

    socket.receive(JSON.stringify({ type: "FutureProviderEnvelope", payload: "ignored?" }));

    await expect(pending).rejects.toMatchObject({
      code: STT_ERROR_CODES.protocolError,
      provider: PROVIDER_NAMES.deepgram,
      retriable: false,
    });
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("rejects an oversized Deepgram frame before parsing it", async () => {
    const socket = new FakeSocket();
    const stream = new DeepgramSttStream(
      socket as never,
      {
        sessionId: "session_deepgram_oversized" as SessionId,
        format: PCM16_16K_MONO,
        interimResults: true,
      },
      fixedClock,
    );
    const pending = stream.events[Symbol.asyncIterator]().next();
    socket.receiveRaw(Buffer.alloc(1_048_577));
    await expect(pending).rejects.toMatchObject({
      code: STT_ERROR_CODES.protocolError,
      provider: PROVIDER_NAMES.deepgram,
    });
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("rejects oversized frames before parsing every legacy STT adapter", async () => {
    const request = {
      sessionId: "session_legacy_oversized" as SessionId,
      format: PCM16_16K_MONO,
      interimResults: true,
    };
    const cases = [
      {
        provider: PROVIDER_NAMES.sarvam,
        create: (socket: FakeSocket) => new SarvamSttStream(socket as never, request, fixedClock),
      },
      {
        provider: PROVIDER_NAMES.elevenlabsStt,
        create: (socket: FakeSocket) =>
          new ElevenLabsSttStream(socket as never, request, fixedClock, "manual"),
      },
      {
        provider: PROVIDER_NAMES.assemblyaiStt,
        create: (socket: FakeSocket) =>
          new AssemblyAiSttStream(socket as never, request, fixedClock),
      },
      {
        provider: PROVIDER_NAMES.sonioxStt,
        create: (socket: FakeSocket) =>
          new SonioxSttStream(socket as never, request, fixedClock, {
            apiKey: "test-key",
            modelId: PROVIDER_CATALOG.soniox.defaultModel,
            context: undefined,
            enableEndpointDetection: true,
            maxEndpointDelayMs: undefined,
            endpointSensitivity: undefined,
            endpointLatencyAdjustmentLevel: undefined,
            enableLanguageIdentification: false,
          }),
      },
    ] as const;

    for (const testCase of cases) {
      const socket = new FakeSocket();
      const stream = testCase.create(socket);
      const pending = stream.events[Symbol.asyncIterator]().next();
      socket.receiveRaw(Buffer.alloc(1_048_577));
      await expect(pending).rejects.toMatchObject({
        code: "provider.stream_buffer_overflow",
        provider: testCase.provider,
      });
      expect(socket.readyState).toBe(WebSocket.CLOSED);
    }
  });

  it("rejects negative Deepgram audio offsets instead of emitting invalid timing", async () => {
    const socket = new FakeSocket();
    const stream = new DeepgramSttStream(
      socket as never,
      {
        sessionId: "session_deepgram_negative_timestamp" as SessionId,
        format: PCM16_16K_MONO,
        interimResults: true,
      },
      fixedClock,
    );
    const pending = stream.events[Symbol.asyncIterator]().next();

    socket.receive(
      JSON.stringify({
        type: "Results",
        start: -0.1,
        duration: 0.2,
        channel: { alternatives: [{ transcript: "invalid" }] },
      }),
    );

    await expect(pending).rejects.toMatchObject({
      code: STT_ERROR_CODES.protocolError,
      provider: PROVIDER_NAMES.deepgram,
    });
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("rejects Deepgram timing that overflows normalized milliseconds", async () => {
    const socket = new FakeSocket();
    const stream = new DeepgramSttStream(
      socket as never,
      {
        sessionId: "session_deepgram_overflow_timestamp" as SessionId,
        format: PCM16_16K_MONO,
        interimResults: true,
      },
      fixedClock,
    );
    const pending = stream.events[Symbol.asyncIterator]().next();

    socket.receive(
      JSON.stringify({
        type: "Results",
        start: 0,
        duration: Number.MAX_VALUE,
        channel: { alternatives: [{ transcript: "invalid" }] },
      }),
    );

    await expect(pending).rejects.toMatchObject({
      code: STT_ERROR_CODES.protocolError,
      provider: PROVIDER_NAMES.deepgram,
    });
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("normalizes synchronous Deepgram and Cartesia socket-factory failures", async () => {
    const request = {
      sessionId: "session_provider_factory_failure" as SessionId,
      format: PCM16_16K_MONO,
      interimResults: true,
    };
    const deepgram = new DeepgramSttProvider({
      apiKey: "test-key",
      webSocketFactory: () => {
        throw new Error("deepgram factory failed");
      },
    });
    await expect(deepgram.open(request)).rejects.toMatchObject({
      category: "provider",
      provider: PROVIDER_NAMES.deepgram,
      code: "stt.transport.connect_failed",
      message: "deepgram factory failed",
    });

    const cartesia = new CartesiaTtsProvider({
      apiKey: "test-key",
      voiceId: "voice",
      webSocketFactory: () => {
        throw new Error("cartesia factory failed");
      },
    });
    await expect(
      cartesia.openSession({
        sessionId: "session_provider_factory_failure" as SessionId,
        turnId: "turn_provider_factory_failure" as TurnId,
        format: PCM16_16K_MONO,
      }),
    ).rejects.toMatchObject({
      category: "provider",
      provider: PROVIDER_NAMES.cartesia,
      message: "cartesia factory failed",
    });
  });

  it("fails a Deepgram stream instead of dropping events when its queue overflows", async () => {
    const socket = new FakeSocket();
    const stream = new DeepgramSttStream(
      socket as never,
      {
        sessionId: "session_deepgram_overflow" as SessionId,
        format: PCM16_16K_MONO,
        interimResults: true,
      },
      fixedClock,
    );
    const iterator = stream.events[Symbol.asyncIterator]();

    for (let index = 0; index < 1025; index += 1) {
      socket.receive(JSON.stringify({ type: "SpeechStarted", timestamp: index / 1000 }));
    }

    await expect(iterator.next()).rejects.toMatchObject({
      code: "provider.stream_buffer_overflow",
      category: "provider",
      provider: "deepgram",
      retriable: false,
    });
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("uses adapter tuning options and keeps an idle raw STT socket alive", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      let openedUrl = "";
      let openedHeaders: Readonly<Record<string, string>> | undefined;
      const provider = new DeepgramSttProvider({
        apiKey: "test-key",
        endpointingMs: 700,
        vadEvents: false,
        punctuate: false,
        webSocketFactory(url, headers) {
          openedUrl = url;
          openedHeaders = headers;
          return socket as never;
        },
      });

      const stream = await provider.open({
        sessionId: "session_deepgram_options" as SessionId,
        format: PCM16_16K_MONO,
        interimResults: true,
      });
      const url = new URL(openedUrl);
      expect(url.searchParams.get("endpointing")).toBe("700");
      expect(url.searchParams.get("vad_events")).toBe("false");
      expect(url.searchParams.get("punctuate")).toBe("false");
      expect(openedHeaders).toEqual({ Authorization: "Token test-key" });

      vi.advanceTimersByTime(5_000);
      expect(socket.sent).toContain(JSON.stringify({ type: "KeepAlive" }));
      const sentBeforeClose = socket.sent.length;
      const closing = stream.close();
      vi.advanceTimersByTime(4_000);
      await expect(closing).rejects.toMatchObject({
        code: STT_ERROR_CODES.closeTimeout,
        provider: PROVIDER_NAMES.deepgram,
        retriable: false,
      });
      vi.advanceTimersByTime(5_000);
      expect(socket.sent).toHaveLength(sentBeforeClose + 1); // CloseStream only.
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces a healthy Deepgram keepalive write failure", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      const provider = new DeepgramSttProvider({
        apiKey: "test-key",
        webSocketFactory: () => socket as never,
      });
      const stream = await provider.open({
        sessionId: "session_deepgram_keepalive_failure" as SessionId,
        format: PCM16_16K_MONO,
        interimResults: true,
      });
      const pending = stream.events[Symbol.asyncIterator]().next();

      socket.readyState = WebSocket.CLOSING;
      vi.advanceTimersByTime(5_000);

      await expect(pending).rejects.toMatchObject({
        code: TVIC_ERROR_CODES.providerTransportWriteFailed,
        retriable: false,
        metadata: expect.objectContaining({ operation: "keepalive" }),
      });
      await stream.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("streams Sarvam PCM audio and maps VAD/flush events", async () => {
    const socket = new FakeSocket();
    let openedUrl = "";
    let openedHeaders: Readonly<Record<string, string>> | undefined;
    const provider = new SarvamSttProvider({
      apiKey: "sarvam-key",
      webSocketFactory(url, headers) {
        openedUrl = url;
        openedHeaders = headers;
        return socket as never;
      },
    });

    const stream = await provider.open({
      sessionId: "session_sarvam" as SessionId,
      format: PCM16_16K_MONO,
      language: "hi-IN",
      interimResults: true,
    });
    const iterator = stream.events[Symbol.asyncIterator]();

    await stream.sendAudio({
      audio: {
        format: PCM16_16K_MONO,
        durationMs: 20,
        frameCount: 320,
        bytes: new Uint8Array([1, 2, 3, 4]),
      },
    } as never);
    await stream.commit();

    const url = new URL(openedUrl);
    expect(url.pathname).toBe("/speech-to-text/ws");
    expect(url.searchParams.get("model")).toBe(PROVIDER_CATALOG.sarvam.defaultModel);
    // Sarvam's WS query parameter is hyphenated, unlike the request's other params.
    expect(url.searchParams.get("language-code")).toBe("hi-IN");
    expect(url.searchParams.has("language_code")).toBe(false);
    expect(url.searchParams.get("input_audio_codec")).toBe("pcm_s16le");
    expect(openedHeaders).toEqual({ "api-subscription-key": "sarvam-key" });
    expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual({
      audio: {
        data: "AQIDBA==",
        sample_rate: "16000",
        // Sarvam currently requires this message-level label for raw PCM
        // frames. The actual codec is declared by the query parameter above.
        encoding: "audio/wav",
      },
    });
    expect(JSON.parse(socket.sent[1] ?? "{}")).toEqual({ type: "flush" });

    socket.receive(JSON.stringify({ type: "events", data: { signal_type: "START_SPEECH" } }));
    // `confidence` is not part of Sarvam's real transcript schema (only
    // `language_probability`, a language-detection signal, exists); included here
    // to prove a field by that name is never surfaced on the resulting event.
    socket.receive(
      JSON.stringify({ type: "data", data: { transcript: "नमस्ते", confidence: 0.99 } }),
    );
    const started = await iterator.next();
    const transcript = await iterator.next();
    const endpoint = await iterator.next();

    expect(started.value).toEqual(expect.objectContaining({ type: "stt.speech.started" }));
    expect(transcript.value).toEqual(
      expect.objectContaining({ type: "stt.final", text: "नमस्ते", provider: "sarvam" }),
    );
    expect(transcript.value).not.toHaveProperty("confidence");
    expect(endpoint.value).toEqual(
      expect.objectContaining({ type: "stt.endpoint", reason: "manual" }),
    );
    await stream.close();
  });

  it("streams ElevenLabs Scribe audio and separates partial, final, and committed events", async () => {
    const socket = new FakeSocket();
    let openedUrl = "";
    let openedHeaders: Readonly<Record<string, string>> | undefined;
    const provider = new ElevenLabsSttProvider({
      apiKey: "eleven-key",
      includeTimestamps: true,
      webSocketFactory(url, headers) {
        openedUrl = url;
        openedHeaders = headers;
        return socket as never;
      },
    });

    const stream = await provider.open({
      sessionId: "session_elevenlabs_stt" as SessionId,
      format: PCM16_16K_MONO,
      language: "en",
      interimResults: true,
      vocabulary: ["TVIC", "Scribe"],
    });
    const iterator = stream.events[Symbol.asyncIterator]();

    await stream.sendAudio({
      audio: {
        format: PCM16_16K_MONO,
        durationMs: 20,
        frameCount: 320,
        bytes: new Uint8Array([5, 6, 7, 8]),
      },
    } as never);
    await stream.commit();

    const url = new URL(openedUrl);
    expect(url.pathname).toBe("/v1/speech-to-text/realtime");
    expect(url.searchParams.get("model_id")).toBe("scribe_v2_realtime");
    expect(url.searchParams.get("audio_format")).toBe("pcm_16000");
    expect(url.searchParams.get("commit_strategy")).toBe("manual");
    expect(url.searchParams.get("include_timestamps")).toBe("true");
    expect(url.searchParams.getAll("keyterms")).toEqual(["TVIC", "Scribe"]);
    expect(openedHeaders).toEqual({ "xi-api-key": "eleven-key" });
    expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual(
      expect.objectContaining({
        message_type: "input_audio_chunk",
        audio_base_64: "BQYHCA==",
        sample_rate: 16000,
      }),
    );
    expect(JSON.parse(socket.sent[1] ?? "{}")).toEqual(
      expect.objectContaining({ message_type: "input_audio_chunk", commit: true }),
    );

    socket.receive(JSON.stringify({ message_type: "partial_transcript", text: "hello wor" }));
    socket.receive(JSON.stringify({ message_type: "committed_transcript", text: "hello world" }));
    socket.receive(
      JSON.stringify({
        message_type: "committed_transcript_with_timestamps",
        text: "hello world",
        words: [
          { text: "hello", start: 0, end: 0.4, type: "word", speaker_id: null },
          { text: "world", start: 0.4, end: 0.8, type: "word", speaker_id: null },
        ],
      }),
    );

    const partial = await iterator.next();
    const final = await iterator.next();
    const endpoint = await iterator.next();
    expect(partial.value).toEqual(
      expect.objectContaining({ type: "stt.partial", text: "hello wor" }),
    );
    expect(final.value).toEqual(
      expect.objectContaining({
        type: "stt.final",
        text: "hello world",
        metadata: expect.objectContaining({
          elevenlabs: expect.objectContaining({ words: expect.any(Array) }),
        }),
      }),
    );
    expect(endpoint.value).toEqual(
      expect.objectContaining({ type: "stt.endpoint", reason: "manual" }),
    );
    await stream.close();
  });

  it("streams AssemblyAI v3 audio and waits for Begin before opening", async () => {
    const socket = new FakeSocket();
    let openedUrl = "";
    let openedHeaders: Readonly<Record<string, string>> | undefined;
    socket.send = (data: string | Buffer): void => {
      if (typeof data !== "string") {
        socket.binarySent.push(Buffer.from(data));
        return;
      }
      socket.sent.push(data);
      if (JSON.parse(data).type === "Terminate") {
        socket.receive(JSON.stringify({ type: "Termination", audio_duration_seconds: 1 }));
      }
    };
    const provider = new AssemblyAiSttProvider({
      apiKey: "assembly-key",
      languageDetection: true,
      speakerLabels: true,
      maxSpeakers: 2,
      speakerLabelsRevisionIntervalMs: 0,
      modelId: "universal-3-5-pro",
      webSocketFactory(url, headers) {
        openedUrl = url;
        openedHeaders = headers;
        queueMicrotask(() =>
          socket.receive(
            JSON.stringify({ type: "Begin", id: "assembly-session", expires_at: 123 }),
          ),
        );
        return socket as never;
      },
    });

    const stream = await provider.open({
      sessionId: "session_assemblyai" as SessionId,
      format: PCM16_16K_MONO,
      language: "en-US",
      interimResults: true,
      vocabulary: ["TVIC"],
    });
    const iterator = stream.events[Symbol.asyncIterator]();

    await stream.sendAudio({
      audio: {
        format: PCM16_16K_MONO,
        durationMs: 100,
        frameCount: 1600,
        bytes: new Uint8Array(3200),
      },
    } as never);
    await stream.commit();
    expect(socket.sent.map((message) => JSON.parse(message).type)).toContain("ForceEndpoint");

    const url = new URL(openedUrl);
    expect(url.pathname).toBe("/v3/ws");
    expect(url.searchParams.get("sample_rate")).toBe("16000");
    expect(url.searchParams.get("speech_model")).toBe("universal-3-5-pro");
    expect(url.searchParams.get("format_turns")).toBe("true");
    expect(url.searchParams.get("language_detection")).toBe("true");
    expect(url.searchParams.get("speaker_labels")).toBe("true");
    expect(url.searchParams.get("max_speakers")).toBe("2");
    expect(url.searchParams.get("speaker_labels_revision_interval_ms")).toBe("0");
    expect(url.searchParams.get("keyterms_prompt")).toBe(JSON.stringify(["TVIC"]));
    expect(url.searchParams.get("language_code")).toBeNull();
    expect(url.searchParams.get("prompt")).toBe("Transcribe en-US.");
    expect(openedHeaders).toEqual({ Authorization: "assembly-key" });
    expect(socket.binarySent[0]).toHaveLength(3200);

    socket.receive(JSON.stringify({ type: "SpeechStarted", timestamp: 0.1, confidence: 0.9 }));
    socket.receive(
      JSON.stringify({
        type: "Turn",
        turn_order: 0,
        transcript: "hello wor",
        end_of_turn: false,
      }),
    );
    socket.receive(
      JSON.stringify({
        type: "Turn",
        turn_order: 0,
        turn_is_formatted: true,
        transcript: "hello world",
        utterance: "hello world",
        end_of_turn: true,
        end_of_turn_confidence: 0.98,
        speaker_label: "A",
        speaker_confidence: 0.97,
      }),
    );
    socket.receive(
      JSON.stringify({
        type: "Turn",
        turn_order: 0,
        transcript: "hello world",
        end_of_turn: true,
      }),
    );

    expect((await iterator.next()).value).toEqual(
      expect.objectContaining({ type: "stt.speech.started" }),
    );
    expect((await iterator.next()).value).toEqual(
      expect.objectContaining({ type: "stt.partial", text: "hello wor" }),
    );
    expect((await iterator.next()).value).toEqual(
      expect.objectContaining({
        type: "stt.final",
        text: "hello world",
        metadata: {
          assemblyai: expect.objectContaining({
            speakerLabel: "A",
            speakerConfidence: 0.97,
          }),
        },
      }),
    );
    expect((await iterator.next()).value).toEqual(
      expect.objectContaining({ type: "stt.endpoint", reason: "provider" }),
    );

    await stream.close();
    expect(socket.sent.map((message) => JSON.parse(message).type)).toContain("Terminate");
  });

  it("flushes AssemblyAI residual audio between 50ms and 100ms without throwing", async () => {
    const socket = new FakeSocket();
    socket.send = (data: string | Buffer): void => {
      if (typeof data !== "string") {
        socket.binarySent.push(Buffer.from(data));
        return;
      }
      socket.sent.push(data);
      if (JSON.parse(data).type === "Terminate") {
        socket.receive(JSON.stringify({ type: "Termination" }));
      }
    };
    const stream = await new AssemblyAiSttProvider({
      apiKey: "assembly-key",
      webSocketFactory: () => {
        queueMicrotask(() => socket.receive(JSON.stringify({ type: "Begin" })));
        return socket as never;
      },
    }).open({
      sessionId: "session_assemblyai_residual" as SessionId,
      format: PCM16_16K_MONO,
      interimResults: true,
    });

    await stream.sendAudio({
      audio: {
        format: PCM16_16K_MONO,
        durationMs: 62.5,
        frameCount: 1000,
        bytes: new Uint8Array(2000),
      },
    } as never);

    await expect(stream.close()).resolves.toBeUndefined();
    expect(socket.binarySent).toHaveLength(1);
    expect(socket.binarySent[0]).toHaveLength(2000);
  });

  it("streams Soniox final/non-final tokens and manual finalization", async () => {
    const socket = new FakeSocket();
    socket.send = (data: string | Buffer): void => {
      if (Buffer.isBuffer(data)) {
        socket.binarySent.push(Buffer.from(data));
        return;
      }
      socket.sent.push(data);
      if (data === "") {
        socket.receive(JSON.stringify({ finished: true }));
        return;
      }
      if (JSON.parse(data).type === "finalize") {
        socket.receive(
          JSON.stringify({
            tokens: [
              { text: "hello", is_final: true, start_ms: 0, end_ms: 400 },
              { text: "<fin>", is_final: true },
            ],
          }),
        );
      }
    };
    const provider = new SonioxSttProvider({
      apiKey: "soniox-key",
      context: { general: [{ key: "domain", value: "voice" }] },
      webSocketFactory: () => socket as never,
    });

    const stream = await provider.open({
      sessionId: "session_soniox" as SessionId,
      format: PCM16_16K_MONO,
      language: "en",
      interimResults: true,
      vocabulary: ["TVIC"],
    });
    const iterator = stream.events[Symbol.asyncIterator]();

    await stream.sendAudio({
      audio: {
        format: PCM16_16K_MONO,
        durationMs: 100,
        frameCount: 1600,
        bytes: new Uint8Array([1, 2, 3, 4]),
      },
    } as never);

    const config = JSON.parse(socket.sent[0] ?? "{}") as Record<string, unknown>;
    expect(config).toEqual(
      expect.objectContaining({
        api_key: "soniox-key",
        model: PROVIDER_CATALOG.soniox.defaultModel,
        audio_format: "pcm_s16le",
        num_channels: 1,
        sample_rate: 16000,
        language_hints: ["en"],
        enable_endpoint_detection: true,
        context: { general: [{ key: "domain", value: "voice" }], terms: ["TVIC"] },
      }),
    );
    expect(socket.binarySent[0]).toEqual(Buffer.from([1, 2, 3, 4]));

    socket.receive(JSON.stringify({ tokens: [{ text: "hel", is_final: false }] }));
    socket.receive(JSON.stringify({ tokens: [{ text: "hello", is_final: false }] }));
    expect((await iterator.next()).value).toEqual(
      expect.objectContaining({ type: "stt.partial", text: "hel" }),
    );
    expect((await iterator.next()).value).toEqual(
      expect.objectContaining({ type: "stt.partial", text: "hello" }),
    );

    const committed = stream.commit();
    expect(JSON.parse(socket.sent[1] ?? "{}")).toEqual({ type: "finalize" });
    expect((await iterator.next()).value).toEqual(
      expect.objectContaining({ type: "stt.final", text: "hello" }),
    );
    expect((await iterator.next()).value).toEqual(
      expect.objectContaining({ type: "stt.endpoint", reason: "manual" }),
    );
    await expect(committed).resolves.toBeUndefined();

    await stream.close();
    expect(socket.sent.at(-1)).toBe("");
    expect(socket.binarySent.at(-1)).not.toEqual(Buffer.alloc(0));
  });

  it("keeps an idle Soniox socket alive and stops after close", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      socket.send = (data: string): void => {
        socket.sent.push(data);
        if (data === "") {
          socket.receive(JSON.stringify({ finished: true }));
        }
      };
      const provider = new SonioxSttProvider({
        apiKey: "soniox-key",
        webSocketFactory: () => socket as never,
      });
      const stream = await provider.open({
        sessionId: "session_soniox_keepalive" as SessionId,
        format: PCM16_16K_MONO,
        interimResults: true,
      });

      vi.advanceTimersByTime(5_000);
      expect(socket.sent).toContain(JSON.stringify({ type: "keepalive" }));
      const sentBeforeClose = socket.sent.length;
      await stream.close();
      vi.advanceTimersByTime(5_000);
      expect(socket.sent).toHaveLength(sentBeforeClose + 1); // close marker only.
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces Sarvam and ElevenLabs provider errors through their event streams", async () => {
    const sarvamSocket = new FakeSocket();
    const sarvamStream = await new SarvamSttProvider({
      apiKey: "sarvam-key",
      webSocketFactory: () => sarvamSocket as never,
    }).open({
      sessionId: "session_sarvam_error" as SessionId,
      format: PCM16_16K_MONO,
      interimResults: true,
    });
    const sarvamPending = sarvamStream.events[Symbol.asyncIterator]().next();
    // Sarvam's documented error envelope nests the message under `data`:
    // https://docs.sarvam.ai/api-reference/speech-to-text/transcribe/ws
    sarvamSocket.receive(
      JSON.stringify({ type: "error", data: { error: "bad request", code: "invalid_audio" } }),
    );
    await expect(sarvamPending).rejects.toMatchObject({
      // Sarvam's own error `code` takes precedence over the generic fallback,
      // mirroring the existing Cartesia error-mapping convention.
      code: "provider.input_rejected",
      provider: "sarvam",
      retriable: false,
      message: "bad request",
      metadata: { providerCode: "invalid_audio" },
    });

    const elevenLabsSocket = new FakeSocket();
    const elevenLabsStream = await new ElevenLabsSttProvider({
      apiKey: "eleven-key",
      webSocketFactory: () => elevenLabsSocket as never,
    }).open({
      sessionId: "session_elevenlabs_error" as SessionId,
      format: PCM16_16K_MONO,
      interimResults: true,
    });
    const elevenLabsPending = elevenLabsStream.events[Symbol.asyncIterator]().next();
    elevenLabsSocket.receive(JSON.stringify({ message_type: "rate_limited", error: "try later" }));
    await expect(elevenLabsPending).rejects.toMatchObject({
      code: "provider.rate_limited",
      provider: "elevenlabs-stt-realtime",
      retriable: true,
    });
  });

  it("classifies Soniox organization balance exhaustion as a quota error", async () => {
    const socket = new FakeSocket();
    const stream = await new SonioxSttProvider({
      apiKey: "soniox-key",
      webSocketFactory: () => socket as never,
    }).open({
      sessionId: "session_soniox_balance" as SessionId,
      format: PCM16_16K_MONO,
      interimResults: true,
    });
    const pending = stream.events[Symbol.asyncIterator]().next();

    socket.receive(
      JSON.stringify({
        error_code: 402,
        error_type: "organization_balance_exhausted",
        error_message: "Organization balance exhausted",
      }),
    );

    await expect(pending).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerQuotaExceeded,
      provider: "soniox-stt",
      retriable: false,
      metadata: { legacyCode: "stt.provider.quota_exceeded" },
    });
    await stream.close();
  });

  it("maps Cartesia chunk/done messages into output media events", async () => {
    const socket = new FakeSocket();
    const stream = new CartesiaTtsStream(
      socket as never,
      {
        sessionId: "session_cartesia" as SessionId,
        turnId: "turn_cartesia" as TurnId,
        text: "confirmed",
        format: PCM16_16K_MONO,
        stream: true,
      },
      {
        voiceId: "voice_1",
        modelId: PROVIDER_CATALOG.cartesia.defaultModel,
        language: "en",
        clock: fixedClock,
        timestamps: false,
        contextId: "context_cartesia_one_shot",
      },
    );
    const iterator = stream.events[Symbol.asyncIterator]();
    const bytes = new Uint8Array(640);

    socket.receive(
      JSON.stringify({
        type: "chunk",
        context_id: "context_cartesia_one_shot",
        data: Buffer.from(bytes).toString("base64"),
      }),
    );
    socket.receive(JSON.stringify({ type: "done", context_id: "context_cartesia_one_shot" }));

    const chunk = await iterator.next();
    const committed = await iterator.next();

    expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual(
      expect.objectContaining({
        model_id: PROVIDER_CATALOG.cartesia.defaultModel,
        transcript: "confirmed",
        voice: "voice_1",
      }),
    );
    expect(chunk.value).toEqual(
      expect.objectContaining({ type: "media.audio.chunk", provider: "cartesia" }),
    );
    if (chunk.value?.type === "media.audio.chunk") {
      expect(chunk.value.audio.frameCount).toBe(320);
    }
    expect(committed.value).toEqual(
      expect.objectContaining({ type: "media.audio.committed", frameCount: 320 }),
    );
  });

  it("uses Cartesia's current WebSocket version, voice shape, and generation controls", async () => {
    const socket = new FakeSocket();
    let openedUrl = "";
    let openedHeaders: Readonly<Record<string, string>> | undefined;
    const provider = new CartesiaTtsProvider({
      apiKey: "cartesia-key",
      voiceId: "voice_current",
      locale: "en-US",
      accent: "american",
      normalization: "auto",
      generationConfig: { volume: 0.9, speed: 0.8, emotion: "friendly" },
      pronunciationDictId: "pronunciation_1",
      maxBufferDelayMs: 250,
      webSocketFactory(url, headers) {
        openedUrl = url;
        openedHeaders = headers;
        return socket as never;
      },
    });

    const session = await provider.openSession({
      sessionId: "session_cartesia_current" as SessionId,
      turnId: "turn_cartesia_current" as TurnId,
      format: PCM16_16K_MONO,
      speed: 1.25,
    });
    await session.sendText("hello");

    const url = new URL(openedUrl);
    expect(url.pathname).toBe("/tts/websocket");
    expect(url.searchParams.get("cartesia_version")).toBe("2026-08-14");
    expect(openedHeaders).toEqual({
      "X-API-Key": "cartesia-key",
      "Cartesia-Version": "2026-08-14",
    });
    expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual(
      expect.objectContaining({
        model_id: "sonic-3.6",
        transcript: "hello",
        voice: "voice_current",
        locale: "en-US",
        accent: "american",
        normalization: "auto",
        pronunciation_dict_id: "pronunciation_1",
        generation_config: { volume: 0.9, speed: 1.25, emotion: "friendly" },
        max_buffer_delay_ms: 250,
      }),
    );
    expect(JSON.parse(socket.sent[0] ?? "{}")).not.toHaveProperty("language");
    await session.cancel();
  });

  it("rejects Cartesia language/locale conflicts and invalid speed before opening", async () => {
    expect(
      () =>
        new CartesiaTtsProvider({
          apiKey: "test",
          voiceId: "voice",
          language: "en",
          locale: "en-US",
        }),
    ).toThrow(/either language or locale/);

    const socket = new FakeSocket();
    let factoryCalls = 0;
    const provider = new CartesiaTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      webSocketFactory: () => {
        factoryCalls += 1;
        return socket as never;
      },
    });

    await expect(
      provider.openSession({
        sessionId: "session_cartesia_invalid_speed" as SessionId,
        turnId: "turn_cartesia_invalid_speed" as TurnId,
        format: PCM16_16K_MONO,
        speed: Number.NaN,
      }),
    ).rejects.toMatchObject({
      category: "validation",
      code: TVIC_ERROR_CODES.providerInvalidRequest,
      provider: PROVIDER_NAMES.cartesia,
    });
    expect(factoryCalls).toBe(0);
  });

  it("rejects an unsupported Cartesia model before opening the socket", async () => {
    const socket = new FakeSocket();
    let factoryCalls = 0;
    const provider = new CartesiaTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      webSocketFactory: () => {
        factoryCalls += 1;
        return socket as never;
      },
    });

    await expect(
      provider.synthesize({
        sessionId: "session_cartesia_invalid_model" as SessionId,
        turnId: "turn_cartesia_invalid_model" as TurnId,
        text: "hello",
        model: "not-a-real-model",
        format: PCM16_16K_MONO,
        stream: true,
      }),
    ).rejects.toMatchObject({
      category: "validation",
      code: "provider.model_unsupported",
      provider: PROVIDER_NAMES.cartesia,
    });
    expect(factoryCalls).toBe(0);
  });

  it("canonicalizes Cartesia errors and keeps vendor codes in metadata", async () => {
    const socket = new FakeSocket();
    const stream = new CartesiaTtsStream(
      socket as never,
      {
        sessionId: "session_cartesia_vendor_error" as SessionId,
        turnId: "turn_cartesia_vendor_error" as TurnId,
        format: PCM16_16K_MONO,
      },
      {
        voiceId: "voice_1",
        modelId: PROVIDER_CATALOG.cartesia.defaultModel,
        language: "en",
        clock: fixedClock,
        timestamps: false,
        contextId: "context_cartesia_vendor_error",
      },
    );
    const pending = stream.events[Symbol.asyncIterator]().next();

    socket.receive(
      JSON.stringify({
        type: "error",
        error_code: "invalid_api_key",
        message: "invalid key",
      }),
    );

    await expect(pending).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerAuthFailed,
      provider: "cartesia",
      metadata: {
        providerCode: "invalid_api_key",
      },
    });
  });

  it("classifies Cartesia error frames before a provider done marker", async () => {
    const socket = new FakeSocket();
    const stream = new CartesiaTtsStream(
      socket as never,
      {
        sessionId: "session_cartesia_rate_limit" as SessionId,
        turnId: "turn_cartesia_rate_limit" as TurnId,
        format: PCM16_16K_MONO,
      },
      {
        voiceId: "voice_1",
        modelId: PROVIDER_CATALOG.cartesia.defaultModel,
        language: "en",
        clock: fixedClock,
        timestamps: false,
        contextId: "context_cartesia_rate_limit",
      },
    );
    const pending = stream.events[Symbol.asyncIterator]().next();

    socket.receive(
      JSON.stringify({
        type: "error",
        done: true,
        context_id: "context_cartesia_rate_limit",
        status_code: 429,
        error_code: "concurrency_limit",
        message: "concurrency limit reached",
      }),
    );

    await expect(pending).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerRateLimited,
      provider: PROVIDER_NAMES.cartesia,
      retriable: true,
    });
  });

  it("streams incremental Cartesia text with flush and alignment events", async () => {
    const socket = new FakeSocket();
    const session = new CartesiaTtsStream(
      socket as never,
      {
        sessionId: "session_cartesia_incremental" as SessionId,
        turnId: "turn_cartesia_incremental" as TurnId,
        format: PCM16_16K_MONO,
        timestamps: true,
      },
      {
        voiceId: "voice_1",
        modelId: PROVIDER_CATALOG.cartesia.defaultModel,
        language: "en",
        clock: fixedClock,
        timestamps: true,
        contextId: "context_cartesia_incremental",
      },
    );

    await session.sendText("Hello, ");
    const flushPromise = session.flush();
    await session.sendText("world.");
    const secondFlushPromise = session.flush();
    await session.finish();

    expect(socket.sent.map((message) => JSON.parse(message) as Record<string, unknown>)).toEqual([
      expect.objectContaining({ transcript: "Hello, ", continue: true, add_timestamps: true }),
      expect.objectContaining({ transcript: "", continue: true, flush: true }),
      expect.objectContaining({ transcript: "world.", continue: true }),
      expect.objectContaining({ transcript: "", continue: true, flush: true }),
      expect.objectContaining({ transcript: "", continue: false }),
    ]);

    const iterator = session.events[Symbol.asyncIterator]();
    socket.receive(
      JSON.stringify({
        type: "chunk",
        context_id: "context_cartesia_incremental",
        data: Buffer.from(new Uint8Array(640)).toString("base64"),
        flush_id: 0,
      }),
    );
    socket.receive(
      JSON.stringify({
        type: "timestamps",
        context_id: "context_cartesia_incremental",
        flush_id: 0,
        word_timestamps: { words: ["Hello"], start: [0], end: [0.4] },
      }),
    );
    socket.receive(
      JSON.stringify({
        type: "flush_done",
        flush_id: 0,
        context_id: "context_cartesia_incremental",
      }),
    );
    await expect(flushPromise).resolves.toEqual({ id: 0, acknowledgedBy: "provider" });
    socket.receive(
      JSON.stringify({
        type: "flush_done",
        flush_id: 1,
        context_id: "context_cartesia_incremental",
      }),
    );
    await expect(secondFlushPromise).resolves.toEqual({ id: 1, acknowledgedBy: "provider" });
    socket.receive(JSON.stringify({ type: "done", context_id: "context_cartesia_incremental" }));

    const chunk = await iterator.next();
    const alignment = await iterator.next();
    const flush = await iterator.next();
    const secondFlush = await iterator.next();
    const committed = await iterator.next();
    expect(chunk.value).toEqual(expect.objectContaining({ sequence: 1 }));
    expect(alignment.value).toEqual(
      expect.objectContaining({
        type: "tts.alignment",
        unit: "word",
        tokens: ["Hello"],
        startMs: [0],
        endMs: [400],
        flushId: 0,
        sequence: 1,
      }),
    );
    expect(flush.value).toEqual(
      expect.objectContaining({
        type: "tts.flush.completed",
        flushId: 0,
        sequence: 2,
        acknowledgedBy: "provider",
      }),
    );
    expect(secondFlush.value).toEqual(
      expect.objectContaining({
        type: "tts.flush.completed",
        flushId: 1,
        sequence: 3,
        acknowledgedBy: "provider",
      }),
    );
    expect(committed.value).toEqual(
      expect.objectContaining({
        type: "media.audio.committed",
        sequence: 2,
        sequenceRange: [1, 1],
      }),
    );
  });

  it("accepts Cartesia's zero-based first flush acknowledgement", async () => {
    const socket = new FakeSocket();
    const session = new CartesiaTtsStream(
      socket as never,
      {
        sessionId: "session_cartesia_zero_flush" as SessionId,
        turnId: "turn_cartesia_zero_flush" as TurnId,
        format: PCM16_16K_MONO,
        timestamps: false,
      },
      {
        voiceId: "voice_1",
        modelId: PROVIDER_CATALOG.cartesia.defaultModel,
        language: "en",
        clock: fixedClock,
        timestamps: false,
        contextId: "context_cartesia_zero_flush",
      },
    );

    const flush = session.flush();
    const iterator = session.events[Symbol.asyncIterator]();
    socket.receive(
      JSON.stringify({
        type: "flush_done",
        flush_id: 0,
        context_id: "context_cartesia_zero_flush",
      }),
    );

    await expect(flush).resolves.toEqual({ id: 0, acknowledgedBy: "provider" });
    await expect(iterator.next()).resolves.toEqual(
      expect.objectContaining({
        done: false,
        value: expect.objectContaining({
          type: "tts.flush.completed",
          flushId: 0,
          sequence: 1,
        }),
      }),
    );
  });

  it("ignores in-order provider flush boundaries without a caller waiter", async () => {
    const socket = new FakeSocket();
    const session = new CartesiaTtsStream(
      socket as never,
      {
        sessionId: "session_cartesia_provider_flush" as SessionId,
        turnId: "turn_cartesia_provider_flush" as TurnId,
        format: PCM16_16K_MONO,
      },
      {
        voiceId: "voice_1",
        modelId: PROVIDER_CATALOG.cartesia.defaultModel,
        language: "en",
        clock: fixedClock,
        timestamps: false,
        contextId: "context_cartesia_provider_flush",
      },
    );
    const iterator = session.events[Symbol.asyncIterator]();
    await session.sendText("Hello.");
    const flush = session.flush();

    socket.receive(
      JSON.stringify({
        type: "chunk",
        context_id: "context_cartesia_provider_flush",
        data: Buffer.from(new Uint8Array(640)).toString("base64"),
        flush_id: 0,
      }),
    );
    socket.receive(
      JSON.stringify({
        type: "flush_done",
        flush_id: 0,
        context_id: "context_cartesia_provider_flush",
      }),
    );
    await expect(flush).resolves.toEqual({ id: 0, acknowledgedBy: "provider" });

    // The live API can emit this provider-owned boundary after resolving the
    // explicit flush, before the final continue:false request is sent.
    socket.receive(
      JSON.stringify({
        type: "flush_done",
        flush_id: 1,
        context_id: "context_cartesia_provider_flush",
      }),
    );
    await session.finish();
    socket.receive(
      JSON.stringify({
        type: "flush_done",
        flush_id: 2,
        context_id: "context_cartesia_provider_flush",
      }),
    );
    socket.receive(JSON.stringify({ type: "done", context_id: "context_cartesia_provider_flush" }));

    await expect(iterator.next()).resolves.toEqual(
      expect.objectContaining({
        done: false,
        value: expect.objectContaining({ type: "media.audio.chunk" }),
      }),
    );
    await expect(iterator.next()).resolves.toEqual(
      expect.objectContaining({
        done: false,
        value: expect.objectContaining({ type: "tts.flush.completed", flushId: 0 }),
      }),
    );
    await expect(iterator.next()).resolves.toEqual(
      expect.objectContaining({
        done: false,
        value: expect.objectContaining({ type: "media.audio.committed" }),
      }),
    );
  });

  it("accepts Cartesia's one-based first flush acknowledgement", async () => {
    const socket = new FakeSocket();
    const session = new CartesiaTtsStream(
      socket as never,
      {
        sessionId: "session_cartesia_one_flush" as SessionId,
        turnId: "turn_cartesia_one_flush" as TurnId,
        format: PCM16_16K_MONO,
      },
      {
        voiceId: "voice_1",
        modelId: PROVIDER_CATALOG.cartesia.defaultModel,
        language: "en",
        clock: fixedClock,
        timestamps: false,
        contextId: "context_cartesia_one_flush",
      },
    );
    const flush = session.flush();
    const iterator = session.events[Symbol.asyncIterator]();
    socket.receive(
      JSON.stringify({
        type: "flush_done",
        flush_id: 1,
        context_id: "context_cartesia_one_flush",
      }),
    );

    await expect(flush).resolves.toEqual({ id: 1, acknowledgedBy: "provider" });
    await session.finish();
    socket.receive(
      JSON.stringify({
        type: "flush_done",
        flush_id: 2,
        context_id: "context_cartesia_one_flush",
      }),
    );
    socket.receive(JSON.stringify({ type: "done", context_id: "context_cartesia_one_flush" }));
    await expect(iterator.next()).resolves.toEqual(
      expect.objectContaining({
        done: false,
        value: expect.objectContaining({
          type: "tts.flush.completed",
          flushId: 1,
          sequence: 1,
        }),
      }),
    );
    await expect(iterator.next()).resolves.toEqual(
      expect.objectContaining({
        done: false,
        value: expect.objectContaining({ type: "media.audio.committed" }),
      }),
    );
  });

  it("enforces cumulative Cartesia transcript bounds before admitting more text", async () => {
    const socket = new FakeSocket();
    const session = new CartesiaTtsStream(
      socket as never,
      {
        sessionId: "session_cartesia_input_bound" as SessionId,
        turnId: "turn_cartesia_input_bound" as TurnId,
        format: PCM16_16K_MONO,
      },
      {
        voiceId: "voice_1",
        modelId: PROVIDER_CATALOG.cartesia.defaultModel,
        language: "en",
        clock: fixedClock,
        timestamps: false,
        contextId: "context_cartesia_input_bound",
      },
    );

    const textChunk = "a".repeat(Math.floor(MAX_CARTESIA_INPUT_UTF16_CODE_UNITS / 10));
    for (let index = 0; index < 10; index += 1) {
      await session.sendText(textChunk);
    }
    await expect(session.sendText("bbbbbbb")).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerInputRejected,
      provider: PROVIDER_NAMES.cartesia,
      retriable: false,
    });
    expect(MAX_CARTESIA_INPUT_UTF8_BYTES).toBeGreaterThan(MAX_CARTESIA_INPUT_UTF16_CODE_UNITS);
  });

  it("rejects skipped Cartesia flush acknowledgements", async () => {
    const socket = new FakeSocket();
    const session = new CartesiaTtsStream(
      socket as never,
      {
        sessionId: "session_cartesia_skipped_flush" as SessionId,
        turnId: "turn_cartesia_skipped_flush" as TurnId,
        format: PCM16_16K_MONO,
      },
      {
        voiceId: "voice_1",
        modelId: PROVIDER_CATALOG.cartesia.defaultModel,
        language: "en",
        clock: fixedClock,
        timestamps: false,
        contextId: "context_cartesia_skipped_flush",
      },
    );
    const flush = session.flush();
    const iterator = session.events[Symbol.asyncIterator]();
    socket.receive(
      JSON.stringify({
        type: "flush_done",
        flush_id: 2,
        context_id: "context_cartesia_skipped_flush",
      }),
    );

    await expect(flush).rejects.toMatchObject({
      code: PROVIDER_ERROR_CODES.cartesiaTts,
      provider: PROVIDER_NAMES.cartesia,
    });
    await expect(iterator.next()).rejects.toMatchObject({
      code: PROVIDER_ERROR_CODES.cartesiaTts,
      provider: PROVIDER_NAMES.cartesia,
    });
  });

  it("declares and performs only Cartesia request cancellation", async () => {
    const socket = new FakeSocket();
    const session = new CartesiaTtsStream(
      socket as never,
      {
        sessionId: "session_cartesia_cancel" as SessionId,
        turnId: "turn_cartesia_cancel" as TurnId,
        format: PCM16_16K_MONO,
      },
      {
        voiceId: "voice_1",
        modelId: PROVIDER_CATALOG.cartesia.defaultModel,
        language: "en",
        clock: fixedClock,
        timestamps: false,
        contextId: "context_cartesia_cancel",
      },
    );
    const provider = new CartesiaTtsProvider({ apiKey: "test", voiceId: "voice" });

    expect(provider.capabilities.cancellation).toMatchObject({ request: true, output: false });
    await session.cancel();
    expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual({
      context_id: "context_cartesia_cancel",
      cancel: true,
    });
    await expect(session.sendText("too late")).rejects.toMatchObject({
      category: "provider",
      provider: "cartesia",
    });
  });

  it("makes finish idempotent and normalizes writes after finish", async () => {
    const socket = new FakeSocket();
    const session = new CartesiaTtsStream(
      socket as never,
      {
        sessionId: "session_cartesia_finish" as SessionId,
        turnId: "turn_cartesia_finish" as TurnId,
        format: PCM16_16K_MONO,
      },
      {
        voiceId: "voice_1",
        modelId: PROVIDER_CATALOG.cartesia.defaultModel,
        language: "en",
        clock: fixedClock,
        timestamps: false,
        contextId: "context_cartesia_finish",
      },
    );

    await session.finish();
    await session.finish();
    expect(socket.sent).toHaveLength(1);
    await expect(session.sendText("too late")).rejects.toMatchObject({
      category: "provider",
      provider: "cartesia",
    });
  });

  it("fails malformed alignment and rejects an outstanding flush", async () => {
    const socket = new FakeSocket();
    const session = new CartesiaTtsStream(
      socket as never,
      {
        sessionId: "session_cartesia_malformed" as SessionId,
        turnId: "turn_cartesia_malformed" as TurnId,
        format: PCM16_16K_MONO,
        timestamps: true,
      },
      {
        voiceId: "voice_1",
        modelId: PROVIDER_CATALOG.cartesia.defaultModel,
        language: "en",
        clock: fixedClock,
        timestamps: true,
        contextId: "context_cartesia_malformed",
      },
    );
    const iterator = session.events[Symbol.asyncIterator]();
    const flush = session.flush();
    const flushAssertion = expect(flush).rejects.toMatchObject({ category: "provider" });

    socket.receive(
      JSON.stringify({
        type: "timestamps",
        context_id: "context_cartesia_malformed",
        word_timestamps: { words: ["broken"], start: [0], end: [] },
      }),
    );

    await expect(iterator.next()).rejects.toMatchObject({ category: "provider" });
    await flushAssertion;
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("rejects an oversized Cartesia frame before parsing it", async () => {
    const socket = new FakeSocket();
    const session = new CartesiaTtsStream(
      socket as never,
      {
        sessionId: "session_cartesia_oversized" as SessionId,
        turnId: "turn_cartesia_oversized" as TurnId,
        format: PCM16_16K_MONO,
      },
      {
        voiceId: "voice_1",
        modelId: PROVIDER_CATALOG.cartesia.defaultModel,
        language: "en",
        clock: fixedClock,
        timestamps: false,
        contextId: "context_cartesia_oversized",
      },
    );
    const pending = session.events[Symbol.asyncIterator]().next();
    socket.receiveRaw(Buffer.alloc(1_048_577));
    await expect(pending).rejects.toMatchObject({
      provider: PROVIDER_NAMES.cartesia,
      category: "provider",
    });
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("fails when Cartesia output exceeds its lifetime byte bound", async () => {
    const socket = new FakeSocket();
    const stream = new CartesiaTtsStream(
      socket as never,
      {
        sessionId: "session_cartesia_output_bound" as SessionId,
        turnId: "turn_cartesia_output_bound" as TurnId,
        format: PCM16_16K_MONO,
      },
      {
        voiceId: "voice_1",
        modelId: PROVIDER_CATALOG.cartesia.defaultModel,
        language: "en",
        clock: fixedClock,
        timestamps: false,
        contextId: "context_cartesia_output_bound",
      },
    );
    const iterator = stream.events[Symbol.asyncIterator]();
    const bytes = new Uint8Array(700_000);
    const encoded = Buffer.from(bytes).toString("base64");
    const chunkMessage = JSON.stringify({
      type: "chunk",
      context_id: "context_cartesia_output_bound",
      data: encoded,
    });
    const completeChunks = Math.floor(MAX_PROVIDER_TTS_OUTPUT_BYTES / bytes.byteLength);
    for (let index = 0; index < completeChunks; index += 1) {
      const pending = iterator.next();
      socket.receive(chunkMessage);
      await expect(pending).resolves.toMatchObject({
        value: { type: "media.audio.chunk" },
        done: false,
      });
    }

    const overflow = iterator.next();
    socket.receive(chunkMessage);
    await expect(overflow).rejects.toMatchObject({
      code: "provider.stream_buffer_overflow",
      provider: PROVIDER_NAMES.cartesia,
    });
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("rejects Cartesia alignment that overflows normalized milliseconds", async () => {
    const socket = new FakeSocket();
    const session = new CartesiaTtsStream(
      socket as never,
      {
        sessionId: "session_cartesia_overflow_alignment" as SessionId,
        turnId: "turn_cartesia_overflow_alignment" as TurnId,
        format: PCM16_16K_MONO,
        timestamps: true,
      },
      {
        voiceId: "voice_1",
        modelId: PROVIDER_CATALOG.cartesia.defaultModel,
        language: "en",
        clock: fixedClock,
        timestamps: true,
        contextId: "context_cartesia_overflow_alignment",
      },
    );
    const pending = session.events[Symbol.asyncIterator]().next();

    socket.receive(
      JSON.stringify({
        type: "timestamps",
        context_id: "context_cartesia_overflow_alignment",
        word_timestamps: {
          words: ["invalid"],
          start: [0],
          end: [Number.MAX_VALUE],
        },
      }),
    );

    await expect(pending).rejects.toMatchObject({ category: "provider" });
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("normalizes Cartesia alignment fields that are not arrays", async () => {
    const socket = new FakeSocket();
    const session = new CartesiaTtsStream(
      socket as never,
      {
        sessionId: "session_cartesia_invalid_alignment" as SessionId,
        turnId: "turn_cartesia_invalid_alignment" as TurnId,
        format: PCM16_16K_MONO,
        timestamps: true,
      },
      {
        voiceId: "voice_1",
        modelId: PROVIDER_CATALOG.cartesia.defaultModel,
        language: "en",
        clock: fixedClock,
        timestamps: true,
        contextId: "context_cartesia_invalid_alignment",
      },
    );
    const pending = session.events[Symbol.asyncIterator]().next();

    socket.receive(
      JSON.stringify({
        type: "timestamps",
        context_id: "context_cartesia_invalid_alignment",
        word_timestamps: { words: "broken", start: [0], end: [0.2] },
      }),
    );

    await expect(pending).rejects.toMatchObject({
      category: "provider",
      provider: PROVIDER_NAMES.cartesia,
    });
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("closes the connected socket when one-shot stream construction fails", async () => {
    const socket = new FakeSocket();
    socket.send = () => {
      throw new Error("write failed");
    };
    const provider = new CartesiaTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      clock: fixedClock,
      webSocketFactory: () => socket as never,
    });

    await expect(
      provider.synthesize({
        sessionId: "session_cartesia_leak" as SessionId,
        turnId: "turn_cartesia_leak" as TurnId,
        text: "hello",
        format: PCM16_16K_MONO,
        stream: true,
      }),
    ).rejects.toMatchObject({ category: "provider", provider: "cartesia" });
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("uses collision-safe context IDs even when the provider clock is fixed", async () => {
    const firstSocket = new FakeSocket();
    const secondSocket = new FakeSocket();
    const sockets = [firstSocket, secondSocket];
    const provider = new CartesiaTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      clock: fixedClock,
      webSocketFactory: () => sockets.shift() as never,
    });
    const request = {
      sessionId: "session_cartesia_ids" as SessionId,
      turnId: "turn_cartesia_ids" as TurnId,
      format: PCM16_16K_MONO,
    };

    const first = await provider.openSession(request);
    const second = await provider.openSession(request);
    await first.sendText("one");
    await second.sendText("two");
    const firstContext = JSON.parse(firstSocket.sent[0] ?? "{}").context_id;
    const secondContext = JSON.parse(secondSocket.sent[0] ?? "{}").context_id;

    expect(firstContext).not.toBe(secondContext);
    expect(firstContext).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(firstContext).toContain("2026-05-20T00_00_00_000Z");
    await first.cancel();
    await second.cancel();
  });

  it("streams OpenAI response text and accumulated tool-call arguments", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        sseStream(
          [
            { type: "response.output_text.delta", delta: "Checking." },
            {
              type: "response.output_item.added",
              output_index: 1,
              item: { type: "function_call", call_id: "call_1", name: "check_availability" },
            },
            {
              type: "response.function_call_arguments.delta",
              output_index: 1,
              delta: '{"partySize":2',
            },
            { type: "response.function_call_arguments.delta", output_index: 1, delta: "}" },
            { type: "response.function_call_arguments.done", output_index: 1 },
            { type: "response.completed" },
          ],
          { lineEnding: "\r\n" },
        ),
        { status: 200 },
      );

    try {
      const provider = new OpenAiResponsesLlmProvider({ apiKey: "test" });
      const completion = await provider.complete({
        sessionId: "session_openai" as SessionId,
        turnId: "turn_openai" as TurnId,
        model: "gpt-test",
        messages: [{ role: "user", content: "book a table" }],
        stream: true,
      });
      const events = [];
      for await (const event of completion.events) {
        events.push(event);
      }

      expect(events.map((event) => event.type)).toEqual([
        "llm.started",
        "llm.token",
        "llm.tool_call",
        "llm.completed",
      ]);
      expect(events.find((event) => event.type === "llm.tool_call")).toEqual(
        expect.objectContaining({
          call: expect.objectContaining({
            callRef: "call_1",
            toolName: "check_availability",
            input: { partySize: 2 },
          }),
        }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fails closed on malformed OpenAI tool-call arguments", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        sseStream([
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { type: "function_call", call_id: "call_bad", name: "lookup" },
          },
          {
            type: "response.function_call_arguments.delta",
            output_index: 0,
            delta: "{bad",
          },
          { type: "response.function_call_arguments.done", output_index: 0 },
          { type: "response.completed" },
        ]),
        { status: 200 },
      );
    try {
      const provider = new OpenAiResponsesLlmProvider({ apiKey: "test" });
      const completion = await provider.complete({
        sessionId: "session_openai_bad_tool" as SessionId,
        turnId: "turn_openai_bad_tool" as TurnId,
        model: "gpt-test",
        messages: [{ role: "user", content: "book a table" }],
        stream: true,
      });
      const events = [];
      for await (const event of completion.events) events.push(event);
      expect(events.at(-1)).toMatchObject({
        type: "llm.failed",
        error: { code: PROVIDER_ERROR_CODES.openaiResponseFailed },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fails a response that ends before a terminal event", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        sseStream([{ type: "response.output_text.delta", delta: "partial" }], {
          includeDone: false,
        }),
        { status: 200 },
      );

    try {
      const provider = new OpenAiResponsesLlmProvider({ apiKey: "test" });
      const completion = await provider.complete({
        sessionId: "session_openai" as SessionId,
        turnId: "turn_openai" as TurnId,
        model: "gpt-test",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      });
      const events = [];
      for await (const event of completion.events) events.push(event);
      expect(events.map((event) => event.type)).toEqual(["llm.started", "llm.token", "llm.failed"]);
      expect(events.at(-1)).toMatchObject({
        type: "llm.failed",
        error: { code: "openai.response.failed", metadata: { reason: "unexpected_eof" } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("accepts a final SSE data line without a trailing blank separator", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        sseStream([{ type: "response.completed" }], {
          includeDone: false,
          terminateLastFrame: false,
        }),
        { status: 200 },
      );

    try {
      const provider = new OpenAiResponsesLlmProvider({ apiKey: "test" });
      const completion = await provider.complete({
        sessionId: "session_openai" as SessionId,
        turnId: "turn_openai" as TurnId,
        model: "gpt-test",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      });
      const events = [];
      for await (const event of completion.events) events.push(event);

      expect(events.map((event) => event.type)).toEqual(["llm.started", "llm.completed"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("maps a named safety identifier only when supplied", async () => {
    const originalFetch = globalThis.fetch;
    const bodies: Array<Readonly<Record<string, unknown>>> = [];
    globalThis.fetch = async (_input, init) => {
      const parsed: unknown = JSON.parse(String(init?.body ?? "{}"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        bodies.push(parsed as Readonly<Record<string, unknown>>);
      }
      return new Response(sseStream([{ type: "response.completed" }]), { status: 200 });
    };
    try {
      const provider = new OpenAiResponsesLlmProvider({ apiKey: "test" });
      for (const safetyIdentifier of [undefined, "safe_user_hash"] as const) {
        const completion = await provider.complete({
          sessionId: "session_openai" as SessionId,
          turnId: "turn_openai" as TurnId,
          model: "gpt-test",
          messages: [{ role: "user", content: "hello" }],
          stream: true,
          ...(safetyIdentifier ? { safetyIdentifier } : {}),
        });
        for await (const _event of completion.events) {
          // Drain the response stream.
        }
      }
      expect(bodies[0]).not.toHaveProperty("safety_identifier");
      expect(bodies[1]).toHaveProperty("safety_identifier", "safe_user_hash");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("socket safety", () => {
  it("classifies outbound buffered-byte pressure before writing", () => {
    const socket = new FakeSocket();
    socket.bufferedAmount = PROVIDER_OUTBOUND_HIGH_WATER_BYTES;
    expect(providerSendCapacity(socket, "x")).toBe("high_water");
    expect(safeSend(socket, "x")).toBe(false);

    socket.bufferedAmount = PROVIDER_OUTBOUND_HARD_LIMIT_BYTES;
    expect(providerSendCapacity(socket, "x")).toBe("hard_limit");
    expect(safeSend(socket, "x")).toBe(false);
  });

  it("safeSend writes only while OPEN and never throws", () => {
    const socket = new FakeSocket();
    expect(safeSend(socket, "hello")).toBe(true);
    expect(socket.sent).toEqual(["hello"]);

    socket.readyState = WebSocket.CLOSING;
    expect(safeSend(socket, "dropped")).toBe(false);
    expect(socket.sent).toEqual(["hello"]);

    const throwing = new FakeSocket();
    throwing.send = () => {
      throw new Error("boom");
    };
    expect(safeSend(throwing, "x")).toBe(false);
  });

  it("safeClose never throws even if close() throws", () => {
    const socket = new FakeSocket();
    socket.close = () => {
      throw new Error("already closed");
    };
    expect(() => safeClose(socket)).not.toThrow();
  });
});

const fixedClock = {
  now(): Timestamp {
    return "2026-05-20T00:00:00.000Z" as Timestamp;
  },
  monotonicNowMs(): number {
    return 0;
  },
};

class FakeSocket {
  readonly sent: string[] = [];
  readonly binarySent: Buffer[] = [];
  // safeSend only writes while the socket is OPEN.
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  closeCalls = 0;
  readonly #handlers = new Map<string, ((value?: unknown) => void)[]>();

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = WebSocket.CLOSED;
    this.#emit("close");
  }

  on(event: "message" | "close" | "error", handler: (value?: never) => void): this {
    const handlers = this.#handlers.get(event) ?? [];
    handlers.push(handler as (value?: unknown) => void);
    this.#handlers.set(event, handlers);
    return this;
  }

  receive(data: string): void {
    this.#emit("message", Buffer.from(data));
  }

  receiveRaw(data: WebSocket.RawData): void {
    this.#emit("message", data);
  }

  #emit(event: string, value?: unknown): void {
    for (const handler of this.#handlers.get(event) ?? []) {
      handler(value);
    }
  }
}

function sseStream(
  events: readonly Readonly<Record<string, unknown>>[],
  options: {
    readonly lineEnding?: "\n" | "\r\n";
    readonly includeDone?: boolean;
    readonly terminateLastFrame?: boolean;
  } = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const lineEnding = options.lineEnding ?? "\n";
  return new ReadableStream({
    start(controller) {
      events.forEach((event, index) => {
        const separator =
          options.terminateLastFrame === false && index === events.length - 1
            ? ""
            : `${lineEnding}${lineEnding}`;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}${separator}`));
      });
      if (options.includeDone !== false) {
        controller.enqueue(encoder.encode(`data: [DONE]${lineEnding}${lineEnding}`));
      }
      controller.close();
    },
  });
}
