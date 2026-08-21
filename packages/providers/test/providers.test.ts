import WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";

import type { CallId, SessionId, TelephonyProvider, Timestamp, TurnId } from "@tvic/core";
import {
  PCM16_16K_MONO,
  RUNTIME_SAMPLE_RATE_HZ,
  isIncrementalTextToSpeechProvider,
} from "@tvic/core";
import { AsyncQueue, bytesToBase64 } from "@tvic/media";

import {
  AssemblyAiSttProvider,
  ElevenLabsSttProvider,
  CartesiaTtsProvider,
  CartesiaTtsStream,
  DeepgramSttProvider,
  DeepgramSttStream,
  OpenAiResponsesLlmProvider,
  SarvamSttProvider,
  SonioxSttProvider,
  TwilioMediaStreamCallHandle,
  requireProviderKind,
  supportsAudioFormat,
  type TwilioMediaStreamSocket,
} from "../src/index.js";
import { PROVIDER_CATALOG } from "../src/catalog.js";
import { safeClose, safeSend } from "../src/common.js";

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
  it("narrows providers by kind", () => {
    expect(requireProviderKind(provider, "telephony")).toBe(provider);
  });

  it("checks normalized audio format support", () => {
    expect(supportsAudioFormat(provider, PCM16_16K_MONO, "input")).toBe(true);
    expect(supportsAudioFormat(provider, PCM16_16K_MONO, "output")).toBe(true);
  });

  it("rejects formats outside the Twilio adapter's declared boundary", () => {
    expect(
      () =>
        new TwilioMediaStreamCallHandle({
          socket: new FakeSocket() as unknown as TwilioMediaStreamSocket,
          callId: "call_twilio" as CallId,
          sessionId: "session_twilio" as SessionId,
          inputFormat: { ...PCM16_16K_MONO, sampleRateHz: 24000 },
        }),
    ).toThrow("requires 16kHz PCM mono");
  });

  it("identifies providers with native incremental TTS sessions", () => {
    const cartesia = new CartesiaTtsProvider({ apiKey: "test", voiceId: "voice" });
    expect(isIncrementalTextToSpeechProvider(cartesia)).toBe(true);
    expect(
      isIncrementalTextToSpeechProvider({ ...cartesia, openSession: undefined } as never),
    ).toBe(false);
  });

  it("normalizes Twilio mulaw media stream input and sends output messages", async () => {
    const socket = new FakeSocket();
    const handle = new TwilioMediaStreamCallHandle({
      socket: socket as unknown as TwilioMediaStreamSocket,
      callId: "call_twilio" as CallId,
      sessionId: "session_twilio" as SessionId,
    });
    const iterator = handle.events[Symbol.asyncIterator]();

    socket.receive(
      JSON.stringify({
        event: "start",
        sequenceNumber: "1",
        streamSid: "MZ123",
        start: { streamSid: "MZ123", callSid: "CA123" },
      }),
    );
    socket.receive(
      JSON.stringify({
        event: "media",
        sequenceNumber: "2",
        streamSid: "MZ123",
        media: {
          track: "inbound",
          chunk: "1",
          timestamp: "20",
          payload: bytesToBase64(new Uint8Array(160)),
        },
      }),
    );
    // The stateful anti-aliased converter keeps a short look-ahead window, so
    // the first realtime packet may not yet contain a complete 20 ms output
    // frame. A second packet exercises continuous chunking rather than making
    // each packet its own resampling boundary.
    socket.receive(
      JSON.stringify({
        event: "media",
        sequenceNumber: "3",
        streamSid: "MZ123",
        media: {
          track: "inbound",
          chunk: "2",
          timestamp: "40",
          payload: bytesToBase64(new Uint8Array(160)),
        },
      }),
    );
    socket.receive(
      JSON.stringify({
        event: "media",
        sequenceNumber: "4",
        streamSid: "MZ123",
        media: {
          track: "inbound",
          chunk: "3",
          timestamp: "60",
          payload: bytesToBase64(new Uint8Array(160)),
        },
      }),
    );

    const started = await iterator.next();
    const audio = await iterator.next();
    const nextAudio = await iterator.next();

    expect(started.value?.type).toBe("media.stream.started");
    expect(audio.value?.type).toBe("media.audio.chunk");
    expect(audio.value?.direction).toBe("input");
    if (audio.value?.type === "media.audio.chunk") {
      expect(audio.value.audio.format.sampleRateHz).toBe(RUNTIME_SAMPLE_RATE_HZ);
      expect(audio.value.audio.frameCount).toBe(320);
      expect(audio.value.sequence).toBe(2);
      expect(audio.value.monotonicOffsetMs).toBe(20);
      expect(audio.value.metadata).toEqual(
        expect.objectContaining({ twilioChunk: "1", twilioStreamSid: "MZ123" }),
      );
    }
    if (nextAudio.value?.type === "media.audio.chunk") {
      expect(nextAudio.value.sequence).toBe(3);
      expect(nextAudio.value.monotonicOffsetMs).toBe(40);
      expect(nextAudio.value.metadata).toEqual(
        expect.objectContaining({ twilioChunk: "2", twilioStreamSid: "MZ123" }),
      );
    }
    expect(nextAudio.value?.type).toBe("media.audio.chunk");

    await handle.send({
      id: "media_output" as never,
      type: "media.audio.chunk",
      sessionId: "session_twilio" as SessionId,
      callId: "call_twilio" as CallId,
      sequence: 1,
      direction: "output",
      timestamp: "2026-05-20T00:00:00.000Z" as never,
      monotonicOffsetMs: 0,
      audio: {
        format: PCM16_16K_MONO,
        durationMs: 20,
        frameCount: 320,
        bytes: new Uint8Array(640),
      },
    });
    await handle.clear();

    expect(socket.sent.map((message) => JSON.parse(message) as { event: string })).toEqual([
      expect.objectContaining({ event: "media" }),
      expect.objectContaining({ event: "clear" }),
    ]);
  });

  it("preserves source metadata when a normalized frame crosses input packets", async () => {
    const socket = new FakeSocket();
    const handle = new TwilioMediaStreamCallHandle({
      socket: socket as unknown as TwilioMediaStreamSocket,
      callId: "call_twilio_cross_boundary" as CallId,
      sessionId: "session_twilio_cross_boundary" as SessionId,
    });
    const iterator = handle.events[Symbol.asyncIterator]();

    socket.receive(JSON.stringify({ event: "start", sequenceNumber: "1", streamSid: "MZcross" }));
    for (const [sequenceNumber, chunk, timestamp] of [
      ["2", "1", "20"],
      ["3", "2", "40"],
      ["4", "3", "60"],
    ] as const) {
      socket.receive(
        JSON.stringify({
          event: "media",
          sequenceNumber,
          streamSid: "MZcross",
          media: {
            track: "inbound",
            chunk,
            timestamp,
            payload: bytesToBase64(new Uint8Array(160)),
          },
        }),
      );
    }

    await iterator.next();
    const firstAudio = await iterator.next();
    const secondAudio = await iterator.next();

    // The streaming resampler's look-ahead makes the first normalized 20 ms
    // frame consume samples from more than one source packet. Its metadata is
    // intentionally the earliest contributing packet, anchoring timing at the
    // frame's start rather than at the flush time.
    expect(firstAudio.value).toEqual(
      expect.objectContaining({
        type: "media.audio.chunk",
        sequence: 2,
        monotonicOffsetMs: 20,
        metadata: expect.objectContaining({ twilioChunk: "1" }),
      }),
    );
    expect(secondAudio.value).toEqual(
      expect.objectContaining({
        type: "media.audio.chunk",
        sequence: 3,
        monotonicOffsetMs: 40,
        metadata: expect.objectContaining({ twilioChunk: "2" }),
      }),
    );
  });

  it("generates unique deterministic Twilio IDs without provider sequence numbers", async () => {
    const socket = new FakeSocket();
    const handle = new TwilioMediaStreamCallHandle({
      socket: socket as unknown as TwilioMediaStreamSocket,
      callId: "call_twilio_ids" as CallId,
      sessionId: "session_twilio_ids" as SessionId,
      clock: fixedClock,
    });
    const iterator = handle.events[Symbol.asyncIterator]();

    socket.receive("invalid");
    socket.receive("still invalid");
    const first = await iterator.next();
    const second = await iterator.next();

    expect(first.value?.id).not.toBe(second.value?.id);
    expect(String(first.value?.id)).toContain(String(fixedClock.now()));
  });

  it("namespaces equal Twilio sequence counters by call across handles", async () => {
    const firstSocket = new FakeSocket();
    const secondSocket = new FakeSocket();
    const first = new TwilioMediaStreamCallHandle({
      socket: firstSocket as unknown as TwilioMediaStreamSocket,
      callId: "call_twilio_first" as CallId,
      sessionId: "session_twilio_first" as SessionId,
      clock: fixedClock,
    });
    const second = new TwilioMediaStreamCallHandle({
      socket: secondSocket as unknown as TwilioMediaStreamSocket,
      callId: "call_twilio_second" as CallId,
      sessionId: "session_twilio_second" as SessionId,
      clock: fixedClock,
    });
    const firstEvent = first.events[Symbol.asyncIterator]().next();
    const secondEvent = second.events[Symbol.asyncIterator]().next();
    const start = JSON.stringify({ event: "start", sequenceNumber: "1", streamSid: "MZ1" });
    firstSocket.receive(start);
    secondSocket.receive(start);

    expect((await firstEvent).value?.id).toBe("call_twilio_first_twilio_event_1_stream_started_1");
    expect((await secondEvent).value?.id).toBe(
      "call_twilio_second_twilio_event_1_stream_started_1",
    );
  });

  it("finishes inbound conversion before emitting remote stream end", async () => {
    const socket = new FakeSocket();
    const handle = new TwilioMediaStreamCallHandle({
      socket: socket as unknown as TwilioMediaStreamSocket,
      callId: "call_twilio_stop" as CallId,
      sessionId: "session_twilio_stop" as SessionId,
    });
    const iterator = handle.events[Symbol.asyncIterator]();
    socket.receive(JSON.stringify({ event: "start", sequenceNumber: "1", streamSid: "MZstop" }));
    socket.receive(
      JSON.stringify({
        event: "media",
        sequenceNumber: "2",
        streamSid: "MZstop",
        media: {
          track: "inbound",
          timestamp: "20",
          payload: bytesToBase64(new Uint8Array(160)),
        },
      }),
    );
    socket.receive(JSON.stringify({ event: "stop", sequenceNumber: "3", streamSid: "MZstop" }));

    await expect(iterator.next()).resolves.toMatchObject({
      value: expect.objectContaining({ type: "media.stream.started" }),
      done: false,
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: expect.objectContaining({
        type: "media.audio.chunk",
        audio: expect.objectContaining({ frameCount: 320 }),
      }),
      done: false,
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: expect.objectContaining({ type: "media.stream.ended" }),
      done: false,
    });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
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
    await stream.close();
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
      await stream.close();
      vi.advanceTimersByTime(5_000);
      expect(socket.sent).toHaveLength(sentBeforeClose + 1); // CloseStream only.
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
        encoding: "pcm_s16le",
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
    socket.receive(JSON.stringify({ message_type: "final_transcript", text: "hello world" }));
    socket.receive(JSON.stringify({ message_type: "committed_transcript", text: "hello world" }));

    const partial = await iterator.next();
    const final = await iterator.next();
    const endpoint = await iterator.next();
    expect(partial.value).toEqual(
      expect.objectContaining({ type: "stt.partial", text: "hello wor" }),
    );
    expect(final.value).toEqual(
      expect.objectContaining({ type: "stt.final", text: "hello world" }),
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

    const url = new URL(openedUrl);
    expect(url.pathname).toBe("/v3/ws");
    expect(url.searchParams.get("sample_rate")).toBe("16000");
    expect(url.searchParams.get("speech_model")).toBe(PROVIDER_CATALOG.assemblyai.defaultModel);
    expect(url.searchParams.get("format_turns")).toBe("true");
    expect(url.searchParams.get("language_detection")).toBe("true");
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
      expect.objectContaining({ type: "stt.final", text: "hello world" }),
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
    // https://docs.sarvam.ai/api-reference/legacy/speech-to-text/transcribe/ws
    sarvamSocket.receive(
      JSON.stringify({ type: "error", data: { error: "bad request", code: "invalid_audio" } }),
    );
    await expect(sarvamPending).rejects.toMatchObject({
      // Sarvam's own error `code` takes precedence over the generic fallback,
      // mirroring the existing Cartesia error-mapping convention.
      code: "invalid_audio",
      provider: "sarvam",
      message: "bad request",
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
      code: "elevenlabs.stt.error",
      provider: "elevenlabs-stt-realtime",
    });
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
        context_id: "ctx_1",
        data: Buffer.from(bytes).toString("base64"),
      }),
    );
    socket.receive(JSON.stringify({ type: "done" }));

    const chunk = await iterator.next();
    const committed = await iterator.next();

    expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual(
      expect.objectContaining({
        model_id: PROVIDER_CATALOG.cartesia.defaultModel,
        transcript: "confirmed",
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
    await session.finish();

    expect(socket.sent.map((message) => JSON.parse(message) as Record<string, unknown>)).toEqual([
      expect.objectContaining({ transcript: "Hello, ", continue: true, add_timestamps: true }),
      expect.objectContaining({ transcript: "", continue: true, flush: true }),
      expect.objectContaining({ transcript: "world.", continue: true }),
      expect.objectContaining({ transcript: "", continue: false }),
    ]);

    const iterator = session.events[Symbol.asyncIterator]();
    socket.receive(
      JSON.stringify({
        type: "chunk",
        data: Buffer.from(new Uint8Array(640)).toString("base64"),
        flush_id: 1,
      }),
    );
    socket.receive(
      JSON.stringify({
        type: "timestamps",
        flush_id: 1,
        word_timestamps: { words: ["Hello"], start: [0], end: [0.4] },
      }),
    );
    socket.receive(JSON.stringify({ type: "flush_done", flush_id: 1 }));
    await expect(flushPromise).resolves.toEqual({ id: 1, acknowledgedBy: "provider" });
    socket.receive(JSON.stringify({ type: "done" }));

    const chunk = await iterator.next();
    const alignment = await iterator.next();
    const flush = await iterator.next();
    const committed = await iterator.next();
    expect(chunk.value).toEqual(expect.objectContaining({ sequence: 1 }));
    expect(alignment.value).toEqual(
      expect.objectContaining({
        type: "tts.alignment",
        unit: "word",
        tokens: ["Hello"],
        startMs: [0],
        endMs: [400],
        flushId: 1,
        sequence: 1,
      }),
    );
    expect(flush.value).toEqual(
      expect.objectContaining({
        type: "tts.flush.completed",
        flushId: 1,
        sequence: 2,
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
        word_timestamps: { words: ["broken"], start: [0], end: [] },
      }),
    );

    await expect(iterator.next()).rejects.toMatchObject({ category: "provider" });
    await flushAssertion;
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
        sseStream([
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
        ]),
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

describe("twilio playout confirmation", () => {
  function makeHandle() {
    const socket = new FakeSocket();
    const handle = new TwilioMediaStreamCallHandle({
      socket: socket as unknown as TwilioMediaStreamSocket,
      callId: "call_twilio" as CallId,
      sessionId: "session_twilio" as SessionId,
    });
    return { socket, handle };
  }

  it("confirms playout only on a mark ack, never on timeout", async () => {
    const { socket, handle } = makeHandle();
    // No ack within the window → unconfirmed (we never claim "heard" without proof).
    expect(await handle.confirmPlayout("m1", 10)).toBe(false);

    const pending = handle.confirmPlayout("m2", 1000);
    socket.receive(JSON.stringify({ event: "mark", streamSid: "s", mark: { name: "m2" } }));
    expect(await pending).toBe(true);
  });

  it("reports unheard when the call drops before the ack", async () => {
    const { socket, handle } = makeHandle();
    const pending = handle.confirmPlayout("m3", 1000);
    socket.close(); // caller hung up before playout reached the mark
    expect(await pending).toBe(false);
  });

  it("does not treat Twilio's clear echo as proof of playout", async () => {
    const { socket, handle } = makeHandle();
    socket.receive(
      JSON.stringify({ event: "start", sequenceNumber: "1", streamSid: "stream_marks" }),
    );
    const pending = handle.confirmPlayout("m_clear", 1000);

    await handle.send(outputAudio());
    await expect(handle.send(committedOutput("m_clear"))).resolves.toBe(true);
    await handle.clear();
    await expect(pending).resolves.toBe(false);

    // Twilio echoes the cleared mark anyway. It must remain invalidated, and a
    // later confirmation lookup must not accidentally turn it into an ack.
    socket.receive(
      JSON.stringify({ event: "mark", streamSid: "stream_marks", mark: { name: "m_clear" } }),
    );
    await expect(handle.confirmPlayout("m_clear", 10)).resolves.toBe(false);
    expect(socket.sent.map((message) => JSON.parse(message).event)).toEqual([
      "media",
      "mark",
      "clear",
    ]);
  });

  it("invalidates a commit mark when an outbound write is undelivered", async () => {
    const { socket, handle } = makeHandle();
    socket.receive(JSON.stringify({ event: "start", sequenceNumber: "1", streamSid: "stream" }));
    socket.readyState = WebSocket.CLOSING;

    await expect(handle.send(outputAudio())).resolves.toBe(true);
    await expect(handle.send(committedOutput("m_failed"))).resolves.toBe(false);
    await expect(handle.confirmPlayout("m_failed", 10)).resolves.toBe(false);
  });

  it("prunes resolved mark records once they are stale, bounding memory on a long call", async () => {
    vi.useFakeTimers();
    try {
      const { socket, handle } = makeHandle();
      socket.receive(JSON.stringify({ event: "start", sequenceNumber: "1", streamSid: "stream" }));

      await handle.send(outputAudio());
      await expect(handle.send(committedOutput("m_old"))).resolves.toBe(true);
      socket.receive(
        JSON.stringify({ event: "mark", streamSid: "stream", mark: { name: "m_old" } }),
      );
      // Confirmed while the record is still fresh: a real ack was observed.
      await expect(handle.confirmPlayout("m_old", 10)).resolves.toBe(true);

      // Advance well past the retention window and trigger the next turn's
      // send/commit, whose `#sendMark` call sweeps stale records.
      await vi.advanceTimersByTimeAsync(120_000);
      await handle.send(outputAudio());
      await handle.send(committedOutput("m_new"));

      // If "m_old" were still cached as acked, this would resolve true
      // immediately instead of waiting out the short timeout with no ack.
      const pending = handle.confirmPlayout("m_old", 5);
      await vi.advanceTimersByTimeAsync(5);
      await expect(pending).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("prunes marks whose confirmation timed out without blocking late acks", async () => {
    vi.useFakeTimers();
    try {
      const { socket, handle } = makeHandle();
      socket.receive(JSON.stringify({ event: "start", sequenceNumber: "1", streamSid: "stream" }));

      await handle.send(outputAudio());
      await expect(handle.send(committedOutput("m_late"))).resolves.toBe(true);
      const lateTimeout = handle.confirmPlayout("m_late", 5);
      await vi.advanceTimersByTimeAsync(5);
      await expect(lateTimeout).resolves.toBe(false);

      socket.receive(
        JSON.stringify({ event: "mark", streamSid: "stream", mark: { name: "m_late" } }),
      );
      await expect(handle.confirmPlayout("m_late", 5)).resolves.toBe(true);

      await handle.send(outputAudio());
      await expect(handle.send(committedOutput("m_timeout"))).resolves.toBe(true);
      const timeout = handle.confirmPlayout("m_timeout", 5);
      await vi.advanceTimersByTimeAsync(5);
      await expect(timeout).resolves.toBe(false);

      // The timed-out mark remains cached for the retention window, then is
      // removed at the next turn.
      await vi.advanceTimersByTimeAsync(60_001);
      await handle.send(outputAudio());
      await handle.send(committedOutput("m_new"));

      const afterPrune = handle.confirmPlayout("m_timeout", 5);
      await vi.advanceTimersByTimeAsync(5);
      await expect(afterPrune).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("socket safety", () => {
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

function outputAudio() {
  return {
    id: "media_output" as never,
    type: "media.audio.chunk" as const,
    sessionId: "session_twilio" as SessionId,
    callId: "call_twilio" as CallId,
    sequence: 1,
    direction: "output" as const,
    timestamp: "2026-05-20T00:00:00.000Z" as never,
    monotonicOffsetMs: 0,
    audio: {
      format: PCM16_16K_MONO,
      durationMs: 20,
      frameCount: 320,
      bytes: new Uint8Array(640),
    },
  };
}

function committedOutput(id: string) {
  return {
    id: id as never,
    type: "media.audio.committed" as const,
    sessionId: "session_twilio" as SessionId,
    callId: "call_twilio" as CallId,
    sequence: 2,
    direction: "output" as const,
    timestamp: "2026-05-20T00:00:00.000Z" as never,
    monotonicOffsetMs: 20,
    durationMs: 20,
    frameCount: 320,
    sequenceRange: [1, 1] as const,
    chunkIds: ["media_output" as never],
  };
}

const fixedClock = {
  now(): Timestamp {
    return "2026-05-20T00:00:00.000Z" as Timestamp;
  },
};

class FakeSocket {
  readonly sent: string[] = [];
  readonly binarySent: Buffer[] = [];
  // safeSend only writes while the socket is OPEN.
  readyState: number = WebSocket.OPEN;
  readonly #handlers = new Map<string, ((value?: unknown) => void)[]>();

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
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

  #emit(event: string, value?: unknown): void {
    for (const handler of this.#handlers.get(event) ?? []) {
      handler(value);
    }
  }
}

function sseStream(
  events: readonly Readonly<Record<string, unknown>>[],
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}
