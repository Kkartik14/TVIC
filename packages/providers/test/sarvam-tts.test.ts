import { EventEmitter } from "node:events";

import WebSocket from "ws";
import { describe, expect, it } from "vitest";

import {
  evaluateProviderCompatibility,
  PCM16_16K_MONO,
  PROVIDER_NAMES,
  TVIC_ERROR_CODES,
  type SessionId,
  type Timestamp,
  type TtsSessionOpenRequest,
  type TtsUsageReporter,
  type TurnId,
} from "@tvic/core";

import {
  SARVAM_TTS_LANGUAGES,
  SARVAM_TTS_VOICES,
  SARVAM_TTS_V4_FLASH_MODEL,
  createSarvamTtsHttpStreamProvider,
  createSarvamTtsRestProvider,
  isSarvamTtsVoiceSupported,
  resolveSarvamTtsVoice,
  SarvamTtsProvider,
  SarvamTtsStream,
  supportsLanguage,
} from "../src/index.js";
import { PROVIDER_CATALOG } from "../src/catalog.js";
import {
  SARVAM_TTS_V4_FLASH_VOICE_CASES,
  SARVAM_TTS_V4_FLASH_VOICES,
} from "../../../scripts/sarvam-tts-v4-voices.js";

describe("Sarvam Bulbul TTS adapter", () => {
  it("counts caller text at each incremental synthesis call", async () => {
    const socket = new FakeSocket();
    const textCharacters: number[] = [];
    const usageReporter: TtsUsageReporter = {
      report() {},
      beginOperation() {
        return { report() {}, notReported() {}, finish() {} };
      },
      reportTextCharacters(value) {
        textCharacters.push(value);
      },
    };
    const provider = new SarvamTtsProvider({
      apiKey: "sarvam-secret",
      language: "en-IN",
      webSocketFactory: () => socket as never,
    });
    const session = await provider.openSession({ ...request, usageReporter });

    await session.sendText("A🌟");

    expect(textCharacters).toEqual([2]);
    expect(provider.usageAccounting).toEqual({ reportsTextCharacters: true });
    await session.cancel();
  });

  it("passes a caller-selected Bulbul v4 Flash model and persona through WebSocket config", async () => {
    const socket = new FakeSocket();
    let openedUrl = "";
    const provider = new SarvamTtsProvider({
      apiKey: "sarvam-secret",
      modelId: SARVAM_TTS_V4_FLASH_MODEL,
      language: "en-IN",
      voiceId: "simran_en_customer",
      webSocketFactory(url) {
        openedUrl = url;
        return socket as never;
      },
    });

    const session = await provider.openSession({
      ...request,
      model: SARVAM_TTS_V4_FLASH_MODEL,
      voice: "simran_en_customer",
    });

    expect(new URL(openedUrl).searchParams.get("model")).toBe(SARVAM_TTS_V4_FLASH_MODEL);
    expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          model: SARVAM_TTS_V4_FLASH_MODEL,
          speaker: "simran_en_customer",
          output_audio_codec: "linear16",
        }),
      }),
    );

    await session.cancel();
  });

  it("omits the V3-only temperature field from V4 WebSocket config", async () => {
    const socket = new FakeSocket();
    const provider = new SarvamTtsProvider({
      apiKey: "sarvam-secret",
      modelId: SARVAM_TTS_V4_FLASH_MODEL,
      language: "en-IN",
      voiceId: "simran_en_customer",
      webSocketFactory: () => socket as never,
    });

    const session = await provider.openSession(request);

    expect(JSON.parse(socket.sent[0] ?? "{}").data).not.toHaveProperty("temperature");
    await session.cancel();
  });

  it("rejects an explicitly configured temperature for V4 before connecting", async () => {
    let factoryCalls = 0;
    const provider = new SarvamTtsProvider({
      apiKey: "sarvam-secret",
      modelId: SARVAM_TTS_V4_FLASH_MODEL,
      language: "en-IN",
      voiceId: "simran_en_customer",
      temperature: 0.5,
      webSocketFactory: () => {
        factoryCalls += 1;
        return new FakeSocket() as never;
      },
    });

    await expect(provider.openSession(request)).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerInvalidRequest,
    });
    expect(factoryCalls).toBe(0);
  });

  it("requires an explicitly selected language for V4, including a request model override", async () => {
    expect(
      () =>
        new SarvamTtsProvider({
          apiKey: "sarvam-secret",
          modelId: SARVAM_TTS_V4_FLASH_MODEL,
          voiceId: "simran_en_customer",
          webSocketFactory: () => new FakeSocket() as never,
        }),
    ).toThrow(/caller-selected language/u);

    let factoryCalls = 0;
    const v3Provider = new SarvamTtsProvider({
      apiKey: "sarvam-secret",
      webSocketFactory: () => {
        factoryCalls += 1;
        return new FakeSocket() as never;
      },
    });
    await expect(
      v3Provider.openSession({
        ...request,
        model: SARVAM_TTS_V4_FLASH_MODEL,
        voice: "simran_en_customer",
      }),
    ).rejects.toThrow(/caller-selected language/u);
    expect(factoryCalls).toBe(0);
  });

  it("requires a caller-selected v4 persona before opening a WebSocket", async () => {
    let factoryCalls = 0;
    const provider = new SarvamTtsProvider({
      apiKey: "sarvam-secret",
      modelId: SARVAM_TTS_V4_FLASH_MODEL,
      language: "en-IN",
      webSocketFactory: () => {
        factoryCalls += 1;
        return new FakeSocket() as never;
      },
    });

    await expect(
      provider.openSession({ ...request, model: SARVAM_TTS_V4_FLASH_MODEL }),
    ).rejects.toMatchObject({ code: TVIC_ERROR_CODES.providerVoiceUnsupported });
    expect(factoryCalls).toBe(0);
  });

  it("rejects the unverified Assamese language before opening a V4 socket", async () => {
    let factoryCalls = 0;
    expect(
      () =>
        new SarvamTtsProvider({
          apiKey: "sarvam-secret",
          modelId: SARVAM_TTS_V4_FLASH_MODEL,
          language: "as-IN",
          webSocketFactory: () => {
            factoryCalls += 1;
            return new FakeSocket() as never;
          },
        }),
    ).toThrow(/language is invalid/u);
    expect(factoryCalls).toBe(0);
  });

  it("rejects blank or overlong caller-selected v4 personas before opening the socket", async () => {
    let factoryCalls = 0;
    const provider = new SarvamTtsProvider({
      apiKey: "sarvam-secret",
      modelId: SARVAM_TTS_V4_FLASH_MODEL,
      language: "en-IN",
      webSocketFactory: () => {
        factoryCalls += 1;
        return new FakeSocket() as never;
      },
    });

    await expect(
      provider.openSession({
        ...request,
        model: SARVAM_TTS_V4_FLASH_MODEL,
        voice: " \t",
      }),
    ).rejects.toMatchObject({ code: "provider.voice_unsupported" });
    await expect(
      provider.openSession({
        ...request,
        model: SARVAM_TTS_V4_FLASH_MODEL,
        voice: "v".repeat(257),
      }),
    ).rejects.toMatchObject({ code: "provider.voice_unsupported" });
    expect(factoryCalls).toBe(0);
    expect(() => resolveSarvamTtsVoice(SARVAM_TTS_V4_FLASH_MODEL, " \t")).toThrow();
  });

  it("rejects v4 personas outside the verified catalog before opening a socket", async () => {
    const socket = new FakeSocket();
    let factoryCalls = 0;
    const provider = new SarvamTtsProvider({
      apiKey: "sarvam-secret",
      modelId: SARVAM_TTS_V4_FLASH_MODEL,
      language: "en-IN",
      webSocketFactory: () => {
        factoryCalls += 1;
        return socket as never;
      },
    });

    await expect(
      provider.openSession({
        ...request,
        model: SARVAM_TTS_V4_FLASH_MODEL,
        voice: "future_en_customer",
      }),
    ).rejects.toMatchObject({ code: TVIC_ERROR_CODES.providerVoiceUnsupported });

    expect(provider.supportsVoice("future_en_customer", SARVAM_TTS_V4_FLASH_MODEL)).toBe(false);
    expect(factoryCalls).toBe(0);
  });

  it("advertises that the WebSocket adapter cannot provide timestamps", () => {
    const provider = new SarvamTtsProvider({ apiKey: "sarvam-secret" });
    expect(provider.capabilities.timestamps).toBe(false);
  });

  it.each([
    [400, TVIC_ERROR_CODES.providerInvalidRequest, false],
    [401, TVIC_ERROR_CODES.providerAuthFailed, false],
    [402, TVIC_ERROR_CODES.providerQuotaExceeded, false],
    [403, TVIC_ERROR_CODES.providerAuthFailed, false],
    [408, TVIC_ERROR_CODES.providerUpstreamFailed, true],
    [409, TVIC_ERROR_CODES.providerUpstreamFailed, true],
    [429, TVIC_ERROR_CODES.providerRateLimited, true],
    [422, TVIC_ERROR_CODES.providerInvalidRequest, false],
    [500, TVIC_ERROR_CODES.providerUpstreamFailed, true],
  ] as const)(
    "maps a rejected WebSocket handshake with status %s to the canonical provider error",
    async (status, code, retriable) => {
      const socket = new EventEmitter() as EventEmitter & {
        readyState: number;
        close(): void;
      };
      socket.readyState = WebSocket.CONNECTING;
      socket.close = () => {
        socket.readyState = WebSocket.CLOSED;
      };
      const provider = new SarvamTtsProvider({
        apiKey: "sarvam-secret",
        webSocketFactory: () => {
          queueMicrotask(() =>
            socket.emit("error", new Error(`Unexpected server response: ${status}`)),
          );
          return socket as never;
        },
      });

      await expect(provider.openSession(request)).rejects.toMatchObject({
        code,
        provider: PROVIDER_NAMES.sarvamTts,
        retriable,
        metadata: { httpStatus: status },
      });
    },
  );

  it("validates voices against the model-specific catalog", () => {
    const provider = new SarvamTtsProvider({ apiKey: "sarvam-secret" });
    expect(provider.supportsVoice("shubh", "bulbul:v3")).toBe(true);
    for (const voice of SARVAM_TTS_VOICES) {
      expect(provider.supportsVoice(voice, SARVAM_TTS_V4_FLASH_MODEL)).toBe(false);
    }
    expect(provider.supportsVoice("simran_en_customer", SARVAM_TTS_V4_FLASH_MODEL)).toBe(true);
    expect(provider.supportsVoice("future_en_customer", SARVAM_TTS_V4_FLASH_MODEL)).toBe(false);
    for (const voice of SARVAM_TTS_V4_FLASH_VOICES) {
      expect(provider.supportsVoice(voice, SARVAM_TTS_V4_FLASH_MODEL)).toBe(true);
    }
    expect(provider.supportsVoice("kangkana_as_conversational", SARVAM_TTS_V4_FLASH_MODEL)).toBe(
      false,
    );
    expect(provider.supportsLanguage("as-IN", SARVAM_TTS_V4_FLASH_MODEL)).toBe(false);
    expect(
      evaluateProviderCompatibility(provider, {
        kind: "tts",
        voice: "shubh",
      }),
    ).toEqual({ compatible: true, issues: [] });
    expect(supportsLanguage(provider, "as-IN", SARVAM_TTS_V4_FLASH_MODEL)).toBe(false);
    expect(isSarvamTtsVoiceSupported(" \t", SARVAM_TTS_V4_FLASH_MODEL)).toBe(false);
    expect(isSarvamTtsVoiceSupported("shubh", SARVAM_TTS_V4_FLASH_MODEL)).toBe(false);
    expect(isSarvamTtsVoiceSupported("future_en_customer", SARVAM_TTS_V4_FLASH_MODEL)).toBe(false);
    expect(isSarvamTtsVoiceSupported("SIMRAN_EN_CUSTOMER", SARVAM_TTS_V4_FLASH_MODEL)).toBe(false);
    expect(isSarvamTtsVoiceSupported("future voice", SARVAM_TTS_V4_FLASH_MODEL)).toBe(false);
    expect(isSarvamTtsVoiceSupported(" simran_en_customer ", SARVAM_TTS_V4_FLASH_MODEL)).toBe(
      false,
    );
    expect(isSarvamTtsVoiceSupported("v".repeat(256), SARVAM_TTS_V4_FLASH_MODEL)).toBe(false);
    expect(isSarvamTtsVoiceSupported("v".repeat(257), SARVAM_TTS_V4_FLASH_MODEL)).toBe(false);
    for (const voice of SARVAM_TTS_V4_FLASH_VOICES) {
      expect(isSarvamTtsVoiceSupported(voice, SARVAM_TTS_V4_FLASH_MODEL)).toBe(true);
    }

    expect(
      evaluateProviderCompatibility(provider, {
        kind: "tts",
        model: SARVAM_TTS_V4_FLASH_MODEL,
        language: "as-IN",
        voice: "kangkana_as_conversational",
      }),
    ).toMatchObject({ compatible: false });
  });

  it("rejects unsupported WebSocket audio content types before decoding them as PCM16", async () => {
    const socket = new FakeSocket();
    const provider = new SarvamTtsProvider({
      apiKey: "sarvam-secret",
      webSocketFactory: () => socket as never,
    });
    const session = await provider.openSession(request);
    const events = (async () => {
      const observed: unknown[] = [];
      for await (const event of session.events) observed.push(event);
      return observed;
    })();
    socket.receive(
      JSON.stringify({
        type: "audio",
        data: {
          content_type: "audio/mulaw",
          audio: Buffer.from([1, 2]).toString("base64"),
        },
      }),
    );

    await expect(events).rejects.toMatchObject({ code: TVIC_ERROR_CODES.providerProtocolInvalid });
    await session.cancel();
  });

  it("opens the documented WebSocket and sends a strict v3 linear16 config", async () => {
    const socket = new FakeSocket();
    let openedUrl = "";
    let openedHeaders: Readonly<Record<string, string>> = {};
    const provider = new SarvamTtsProvider({
      apiKey: "sarvam-secret",
      language: "hi-IN",
      voiceId: "ishita",
      webSocketFactory(url, headers) {
        openedUrl = url;
        openedHeaders = headers;
        return socket as never;
      },
    });

    const session = await provider.openSession({
      ...request,
      voice: "ishita",
      speed: 1.2,
    });

    const url = new URL(openedUrl);
    expect(url.pathname).toBe("/text-to-speech/ws");
    expect(url.searchParams.get("model")).toBe(PROVIDER_CATALOG.sarvamTts.defaultModel);
    expect(url.searchParams.get("send_completion_event")).toBe("true");
    expect(openedHeaders).toEqual({ "api-subscription-key": "sarvam-secret" });
    expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual({
      type: "config",
      data: {
        model: "bulbul:v3",
        language_code: "hi-IN",
        speaker: "ishita",
        pace: 1.2,
        temperature: 0.6,
        speech_sample_rate: "16000",
        output_audio_codec: "linear16",
        min_buffer_size: 50,
        max_chunk_length: 150,
      },
    });

    await session.cancel();
  });

  it("closes an opened socket when one-shot synthesis is aborted before its final event", async () => {
    const socket = new FakeSocket();
    const controller = new AbortController();
    const provider = new SarvamTtsProvider({
      apiKey: "sarvam-secret",
      language: "en-IN",
      webSocketFactory: () => socket as never,
    });
    const flushSent = new Promise<void>((resolve) => {
      socket.onSent = (data) => {
        if (JSON.parse(data).type === "flush") resolve();
      };
    });

    const synthesis = provider.synthesize({
      ...request,
      text: "Hello from TVIC.",
      stream: true,
      signal: controller.signal,
    });
    await flushSent;
    expect(socket.sent.map((message) => JSON.parse(message).type)).toEqual([
      "config",
      "text",
      "flush",
    ]);

    controller.abort();

    await expect(synthesis).rejects.toMatchObject({ code: "provider.connection_cancelled" });
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("declares the supported Bulbul models and the legacy v3 voice catalog", () => {
    const provider = new SarvamTtsProvider({ apiKey: "sarvam-secret" });
    expect(provider.capabilities.models).toEqual(["bulbul:v3", "bulbul:v4-flash"]);
    expect(provider.capabilities.languages).toEqual(["en-IN"]);
    expect(provider.capabilities.voices).toEqual(SARVAM_TTS_VOICES);
    expect(SARVAM_TTS_VOICES).toHaveLength(37);
    expect(SARVAM_TTS_LANGUAGES).toHaveLength(11);
  });

  it("exposes a configured V4 voice catalog without conflating it with V3", () => {
    const provider = new SarvamTtsProvider({
      apiKey: "sarvam-secret",
      modelId: SARVAM_TTS_V4_FLASH_MODEL,
      language: "en-IN",
    });

    expect(provider.capabilities.voices).toEqual(SARVAM_TTS_V4_FLASH_VOICES);
    expect(provider.capabilities.voices).toHaveLength(222);
    expect(provider.supportsVoice("shubh", SARVAM_TTS_V4_FLASH_MODEL)).toBe(false);
    expect(provider.supportsVoice("simran_en_customer", "bulbul:v3")).toBe(false);
  });

  it("accepts documented V4 Malayalam and Odia language codes but excludes Assamese", () => {
    for (const language of ["ml-IN", "od-IN"]) {
      const provider = new SarvamTtsProvider({
        apiKey: "sarvam-secret",
        modelId: SARVAM_TTS_V4_FLASH_MODEL,
        language,
      });

      expect(provider.supportsLanguage(language, SARVAM_TTS_V4_FLASH_MODEL)).toBe(true);
      expect(provider.capabilities.languages).toEqual([language]);
    }

    const provider = new SarvamTtsProvider({
      apiKey: "sarvam-secret",
      modelId: SARVAM_TTS_V4_FLASH_MODEL,
      language: "en-IN",
    });
    expect(provider.supportsLanguage("as-IN", SARVAM_TTS_V4_FLASH_MODEL)).toBe(false);
  });

  it("requires an explicit V4 language in compatibility preflight for every transport", () => {
    const implicitProviders = [
      new SarvamTtsProvider({ apiKey: "sarvam-secret" }),
      createSarvamTtsRestProvider({ apiKey: "sarvam-secret" }),
      createSarvamTtsHttpStreamProvider({ apiKey: "sarvam-secret" }),
    ];
    for (const provider of implicitProviders) {
      expect(
        evaluateProviderCompatibility(provider, {
          kind: "tts",
          model: SARVAM_TTS_V4_FLASH_MODEL,
          language: "en-IN",
          voice: "simran_en_customer",
        }),
      ).toMatchObject({ compatible: false, issues: [{ code: "language.unsupported" }] });
    }

    const explicitlyConfiguredProviders = [
      new SarvamTtsProvider({ apiKey: "sarvam-secret", language: "en-IN" }),
      createSarvamTtsRestProvider({ apiKey: "sarvam-secret", language: "en-IN" }),
      createSarvamTtsHttpStreamProvider({ apiKey: "sarvam-secret", language: "en-IN" }),
    ];
    for (const provider of explicitlyConfiguredProviders) {
      expect(
        evaluateProviderCompatibility(provider, {
          kind: "tts",
          model: SARVAM_TTS_V4_FLASH_MODEL,
          language: "en-IN",
          voice: "simran_en_customer",
        }),
      ).toEqual({ compatible: true, issues: [] });
    }
  });

  it("rejects a compatibility language that differs from the configured WebSocket language", () => {
    const provider = new SarvamTtsProvider({
      apiKey: "sarvam-secret",
      modelId: SARVAM_TTS_V4_FLASH_MODEL,
      language: "en-IN",
    });

    expect(provider.capabilities.languages).toEqual(["en-IN"]);
    expect(provider.supportsLanguage("hi-IN", SARVAM_TTS_V4_FLASH_MODEL)).toBe(false);
    expect(
      evaluateProviderCompatibility(provider, {
        kind: "tts",
        model: SARVAM_TTS_V4_FLASH_MODEL,
        language: "hi-IN",
      }),
    ).toMatchObject({ compatible: false, issues: [{ code: "language.unsupported" }] });
  });

  it("accepts every documented voice without falling back to another voice", async () => {
    for (const voice of SARVAM_TTS_VOICES) {
      const socket = new FakeSocket();
      const provider = new SarvamTtsProvider({
        apiKey: "sarvam-secret",
        language: "en-IN",
        voiceId: voice,
        webSocketFactory: () => socket as never,
      });
      const session = await provider.openSession({ ...request, voice });
      const config = JSON.parse(socket.sent[0] ?? "{}");
      expect(config.data.speaker).toBe(voice);
      await session.cancel();
    }
  });

  it("sends every documented V4 voice with its matching language over WebSocket", async () => {
    let cases = 0;
    const voiceCases = [
      ...SARVAM_TTS_V4_FLASH_VOICE_CASES,
      { voice: "aparna_hi_customer", language: "en-IN" as const },
    ];

    for (const { voice, language } of voiceCases) {
      const socket = new FakeSocket();
      let openedUrl = "";
      const provider = new SarvamTtsProvider({
        apiKey: "sarvam-secret",
        modelId: SARVAM_TTS_V4_FLASH_MODEL,
        language,
        voiceId: voice,
        webSocketFactory(url) {
          openedUrl = url;
          return socket as never;
        },
      });
      const session = await provider.openSession({
        ...request,
        model: SARVAM_TTS_V4_FLASH_MODEL,
        voice,
      });

      expect(new URL(openedUrl).searchParams.get("model")).toBe(SARVAM_TTS_V4_FLASH_MODEL);
      expect(JSON.parse(socket.sent[0] ?? "{}").data).toMatchObject({
        model: SARVAM_TTS_V4_FLASH_MODEL,
        language_code: language,
        speaker: voice,
      });
      expect(JSON.parse(socket.sent[0] ?? "{}").data).not.toHaveProperty("temperature");
      await session.cancel();
      cases += 1;
    }

    expect(cases).toBe(voiceCases.length);
  });

  it("streams decoded linear16 audio, correlates final events to flushes, and commits each turn", async () => {
    const socket = new FakeSocket();
    const session = new SarvamTtsStream(socket as never, request, {
      clock: fixedClock,
      model: "bulbul:v3",
      language: "en-IN",
      voice: "shubh",
      pace: 1,
      temperature: 0.6,
      minBufferSize: 50,
      maxChunkLength: 150,
      keepAliveIntervalMs: 60_000,
    });
    const iterator = session.events[Symbol.asyncIterator]();

    await session.sendText("Hello from TVIC.");
    expect(JSON.parse(socket.sent[1] ?? "{}")).toEqual({
      type: "text",
      data: { text: "Hello from TVIC." },
    });
    const flush = session.flush();
    expect(JSON.parse(socket.sent[2] ?? "{}")).toEqual({ type: "flush" });

    const pcm = new Uint8Array(640).fill(7);
    socket.receive(
      JSON.stringify({
        type: "audio",
        data: {
          content_type: "audio/pcm",
          audio: Buffer.from(pcm).toString("base64"),
          request_id: "sarvam-request-1",
        },
      }),
    );
    socket.receive(JSON.stringify({ type: "event", data: { event_type: "final" } }));

    await expect(flush).resolves.toMatchObject({ id: 1, acknowledgedBy: "provider" });
    const events = [await iterator.next(), await iterator.next(), await iterator.next()].map(
      (result) => result.value,
    );
    expect(events).toEqual([
      expect.objectContaining({
        type: "media.audio.chunk",
        provider: PROVIDER_NAMES.sarvamTts,
        audio: expect.objectContaining({ bytes: pcm, frameCount: 320 }),
        metadata: expect.objectContaining({
          sarvam: expect.objectContaining({
            contentType: "audio/pcm",
            wireFormat: "linear16",
          }),
        }),
      }),
      expect.objectContaining({
        type: "media.audio.committed",
        provider: PROVIDER_NAMES.sarvamTts,
        frameCount: 320,
        chunkIds: [expect.any(String)],
      }),
      expect.objectContaining({
        type: "tts.flush.completed",
        provider: PROVIDER_NAMES.sarvamTts,
        flushId: 1,
        acknowledgedBy: "provider",
      }),
    ]);

    await session.cancel();
  });

  it("strips a valid WAV wrapper when the provider labels linear16 as audio/wav", async () => {
    const socket = new FakeSocket();
    const session = new SarvamTtsStream(socket as never, request, streamOptions());
    const iterator = session.events[Symbol.asyncIterator]();
    const pcm = new Uint8Array(320).fill(3);
    const wav = makeWav(pcm);
    const flush = session.flush();

    socket.receive(
      JSON.stringify({
        type: "audio",
        data: { content_type: "audio/wav", audio: Buffer.from(wav).toString("base64") },
      }),
    );
    socket.receive(JSON.stringify({ type: "event", data: { event_type: "final" } }));

    await flush;
    const audio = (await iterator.next()).value;
    expect(audio).toEqual(
      expect.objectContaining({
        type: "media.audio.chunk",
        audio: expect.objectContaining({ bytes: pcm, frameCount: 160 }),
        metadata: expect.objectContaining({
          sarvam: expect.objectContaining({ contentType: "audio/wav", wireFormat: "wav" }),
        }),
      }),
    );
    await session.cancel();
  });

  it("sends explicit keepalive pings and finishes only after the provider final event", async () => {
    const socket = new FakeSocket();
    const session = new SarvamTtsStream(socket as never, request, streamOptions());
    await session.keepAlive();
    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toEqual({ type: "ping" });

    const finished = session.finish();
    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toEqual({ type: "flush" });
    let settled = false;
    void finished.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    socket.receive(JSON.stringify({ type: "event", data: { event_type: "final" } }));
    await finished;
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("makes concurrent finish callers wait for the same provider final event", async () => {
    const socket = new FakeSocket();
    const session = new SarvamTtsStream(socket as never, request, streamOptions());
    let firstSettled = false;
    let secondSettled = false;

    const first = session.finish().then(() => {
      firstSettled = true;
    });
    const second = session.finish().then(() => {
      secondSettled = true;
    });

    await Promise.resolve();
    expect(firstSettled).toBe(false);
    expect(secondSettled).toBe(false);
    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toEqual({ type: "flush" });

    socket.receive(JSON.stringify({ type: "event", data: { event_type: "final" } }));
    await Promise.all([first, second]);

    expect(firstSettled).toBe(true);
    expect(secondSettled).toBe(true);
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("rejects every concurrent finish caller when the provider fails before final", async () => {
    const socket = new FakeSocket();
    const session = new SarvamTtsStream(socket as never, request, streamOptions());
    const first = session.finish();
    const second = session.finish();

    socket.receive(JSON.stringify({ type: "error", data: { message: "provider failed" } }));
    const results = await Promise.allSettled([first, second]);

    expect(results.map(({ status }) => status)).toEqual(["rejected", "rejected"]);
    if (results[0]?.status !== "rejected" || results[1]?.status !== "rejected") {
      throw new Error("concurrent finish callers did not both reject");
    }
    expect(results[0].reason).toBe(results[1].reason);
  });

  it("rejects concurrent finish callers when the socket closes during the first flush", async () => {
    const socket = new FakeSocket();
    const session = new SarvamTtsStream(socket as never, request, streamOptions());
    socket.readyState = WebSocket.CLOSING;

    const first = session.finish();
    const second = session.finish();
    expect(first).toBe(second);
    const results = await Promise.allSettled([first, second]);

    expect(results.map(({ status }) => status)).toEqual(["rejected", "rejected"]);
    if (results[0]?.status !== "rejected" || results[1]?.status !== "rejected") {
      throw new Error("concurrent finish callers did not both reject");
    }
    expect(results[0].reason).toBe(results[1].reason);
  });

  it("keeps finish as a no-op when the stream was already closed", async () => {
    const socket = new FakeSocket();
    const session = new SarvamTtsStream(socket as never, request, streamOptions());
    await session.cancel();

    await expect(session.finish()).resolves.toBeUndefined();
  });

  it("rejects unsupported model, voice, language, format, and v3-only invalid options before connecting", async () => {
    let factoryCalls = 0;
    const provider = new SarvamTtsProvider({
      apiKey: "sarvam-secret",
      language: "en-IN",
      webSocketFactory: () => {
        factoryCalls += 1;
        return new FakeSocket() as never;
      },
    });

    await expect(provider.openSession({ ...request, model: "bulbul:v2" })).rejects.toMatchObject({
      code: "provider.model_unsupported",
    });
    await expect(provider.openSession({ ...request, voice: "not-a-voice" })).rejects.toMatchObject({
      code: "provider.voice_unsupported",
    });
    expect(() => new SarvamTtsProvider({ apiKey: "sarvam-secret", language: "as-IN" })).toThrow(
      /language is invalid/u,
    );
    await expect(
      provider.openSession({ ...request, format: { ...PCM16_16K_MONO, sampleRateHz: 8_000 } }),
    ).rejects.toMatchObject({ code: "provider.invalid_request" });
    await expect(
      new SarvamTtsProvider({ apiKey: "sarvam-secret", pace: 2.1 }).openSession(request),
    ).rejects.toMatchObject({ code: "provider.invalid_request" });
    await expect(provider.openSession({ ...request, timestamps: true })).rejects.toMatchObject({
      code: "provider.invalid_request",
    });
    expect(factoryCalls).toBe(0);
  });

  it("fails malformed provider frames and never emits corrupt audio", async () => {
    const cases = [
      JSON.stringify({ type: "audio", data: { content_type: "audio/linear16", audio: "%%%" } }),
      JSON.stringify({ type: "audio", data: { content_type: "audio/linear16", audio: "AA==" } }),
      JSON.stringify({ type: "event", data: { event_type: "unknown" } }),
      JSON.stringify({ type: "unexpected", data: {} }),
    ];

    for (const body of cases) {
      const socket = new FakeSocket();
      const session = new SarvamTtsStream(socket as never, request, streamOptions());
      const pending = session.events[Symbol.asyncIterator]().next();
      socket.receive(body);
      await expect(pending).rejects.toMatchObject({
        code: TVIC_ERROR_CODES.providerProtocolInvalid,
        provider: PROVIDER_NAMES.sarvamTts,
      });
      expect(socket.readyState).toBe(WebSocket.CLOSED);
    }
  });

  it("maps provider errors to canonical retry policy and preserves the vendor code", async () => {
    const socket = new FakeSocket();
    const session = new SarvamTtsStream(socket as never, request, streamOptions());
    const pending = session.events[Symbol.asyncIterator]().next();
    socket.receive(
      JSON.stringify({
        type: "error",
        data: { code: 429, message: "rate limit exceeded" },
      }),
    );

    await expect(pending).rejects.toMatchObject({
      code: "provider.rate_limited",
      retriable: true,
      metadata: { providerCode: "429" },
    });
  });

  it("marks a terminal 429 after emitted audio as an unknown, non-retriable outcome", async () => {
    const socket = new FakeSocket();
    const session = new SarvamTtsStream(socket as never, request, streamOptions());
    const iterator = session.events[Symbol.asyncIterator]();
    const pcm = new Uint8Array(640).fill(7);
    socket.receive(
      JSON.stringify({
        type: "audio",
        data: { content_type: "audio/pcm", audio: Buffer.from(pcm).toString("base64") },
      }),
    );

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "media.audio.chunk" },
    });
    socket.receive(
      JSON.stringify({
        type: "error",
        data: { code: 429, message: "rate limit exceeded" },
      }),
    );

    await expect(iterator.next()).rejects.toMatchObject({
      code: "provider.rate_limited",
      retriable: false,
      metadata: { providerCode: "429", audioStarted: true, outcomeUnknown: true },
    });
  });

  it("marks a socket close after text submission as an unknown, non-retriable outcome", async () => {
    const socket = new FakeSocket();
    const session = new SarvamTtsStream(socket as never, request, streamOptions());
    const pending = session.events[Symbol.asyncIterator]().next();
    await session.sendText("This request may already be generating.");

    socket.endFromServer(1006);

    await expect(pending).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerUpstreamFailed,
      retriable: false,
      metadata: { wsCloseCode: 1006, outcomeUnknown: true },
    });
  });

  it("maps exhausted credits to a permanent quota error", async () => {
    const socket = new FakeSocket();
    const session = new SarvamTtsStream(socket as never, request, streamOptions());
    const pending = session.events[Symbol.asyncIterator]().next();
    socket.receive(
      JSON.stringify({
        type: "error",
        data: { code: "insufficient_balance", message: "Account credits exhausted" },
      }),
    );

    await expect(pending).rejects.toMatchObject({
      code: "provider.quota_exceeded",
      retriable: false,
      metadata: { providerCode: "insufficient_balance" },
    });
  });
});

const request: TtsSessionOpenRequest = {
  sessionId: "session_sarvam_tts" as SessionId,
  turnId: "turn_sarvam_tts" as TurnId,
  format: PCM16_16K_MONO,
};

function streamOptions() {
  return {
    clock: fixedClock,
    model: "bulbul:v3",
    language: "en-IN",
    voice: "shubh",
    pace: 1,
    temperature: 0.6,
    minBufferSize: 50,
    maxChunkLength: 150,
    keepAliveIntervalMs: 60_000,
  } as const;
}

const fixedClock = {
  now(): Timestamp {
    return "2026-09-24T00:00:00.000Z" as Timestamp;
  },
};

function makeWav(pcm: Uint8Array): Uint8Array {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(32_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.byteLength, 40);
  return new Uint8Array(Buffer.concat([header, Buffer.from(pcm)]));
}

class FakeSocket {
  readonly sent: string[] = [];
  onSent: ((data: string) => void) | undefined;
  readyState: number = WebSocket.OPEN;
  readonly #handlers = new Map<string, ((value?: unknown) => void)[]>();

  send(data: string): void {
    this.sent.push(data);
    this.onSent?.(data);
  }

  close(): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.#emit("close", 1000, Buffer.alloc(0));
  }

  endFromServer(code = 1006, reason = Buffer.alloc(0)): void {
    this.readyState = WebSocket.CLOSED;
    this.#emit("close", code, reason);
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

  #emit(event: string, ...values: unknown[]): void {
    for (const handler of this.#handlers.get(event) ?? []) {
      handler(...values);
    }
  }
}
