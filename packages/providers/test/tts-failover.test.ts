import { EventEmitter } from "node:events";

import WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";

import {
  createMediaEvent,
  createSpeechControlCatalogSnapshot,
  nowTimestamp,
  PCM16_16K_MONO,
  querySpeechControlCatalog,
  TVIC_ERROR_CODES,
  evaluateProviderCompatibility,
  isIncrementalTextToSpeechProvider,
  providerError,
  TvicThrowableError,
  validationError,
  type ProviderCapabilities,
  type TextToSpeechProvider,
  type TtsAlignmentEvent,
  type TtsEvent,
  type TtsStream,
  type TtsSynthesisRequest,
  type TtsUsageReporter,
} from "@tvic/core";

import {
  createCartesiaTtsProvider as createCartesiaTtsProviderImpl,
  createElevenLabsTtsHttpStreamProvider as createElevenLabsTtsHttpStreamProviderImpl,
  createElevenLabsTtsProvider as createElevenLabsTtsProviderImpl,
  createElevenLabsTtsRestProvider as createElevenLabsTtsRestProviderImpl,
  createSarvamTtsProvider,
  createSarvamTtsRestProvider,
  createTtsFailoverProvider,
} from "../src/index.js";
import type { CartesiaTtsProviderOptions } from "../src/cartesia.js";
import type { ElevenLabsHttpTtsProviderOptions } from "../src/elevenlabs-http.js";
import type { ElevenLabsTtsProviderOptions } from "../src/elevenlabs-options.js";
import { cartesiaVoiceCatalog, elevenLabsVoiceCatalog } from "./speech-control-catalog-fixtures.js";

function createCartesiaTtsProvider(options: CartesiaTtsProviderOptions) {
  return createCartesiaTtsProviderImpl({
    ...options,
    speechControlCatalog:
      options.speechControlCatalog ??
      cartesiaVoiceCatalog(options.voiceId, {
        ...(options.modelId !== undefined ? { extraModels: [options.modelId] } : {}),
      }),
  });
}

function withElevenLabsVoiceCatalog<
  T extends ElevenLabsTtsProviderOptions | ElevenLabsHttpTtsProviderOptions,
>(options: T): T & { readonly speechControlCatalog: ReturnType<typeof elevenLabsVoiceCatalog> } {
  return {
    ...options,
    speechControlCatalog:
      options.speechControlCatalog ??
      elevenLabsVoiceCatalog(
        [options.voiceId, ...(options.dialogueVoices ?? [])],
        options.allowUnknownModel && options.modelId !== undefined
          ? { extraModels: [options.modelId] }
          : {},
      ),
  };
}

function createElevenLabsTtsProvider(options: ElevenLabsTtsProviderOptions) {
  return createElevenLabsTtsProviderImpl(withElevenLabsVoiceCatalog(options));
}

function createElevenLabsTtsRestProvider(options: ElevenLabsHttpTtsProviderOptions) {
  return createElevenLabsTtsRestProviderImpl(withElevenLabsVoiceCatalog(options));
}

function createElevenLabsTtsHttpStreamProvider(options: ElevenLabsHttpTtsProviderOptions) {
  return createElevenLabsTtsHttpStreamProviderImpl(withElevenLabsVoiceCatalog(options));
}

const CAPABILITIES = {
  streaming: { input: false, output: true, native: true },
  cancellation: { request: true, output: true, buffer: false, truncation: false },
  transports: ["http"],
  audio: { output: [PCM16_16K_MONO] },
  models: ["primary-model"],
  voices: ["primary-voice"],
} satisfies ProviderCapabilities;

function request(): TtsSynthesisRequest {
  return {
    sessionId: "failover-session" as never,
    turnId: "failover-turn" as never,
    text: "Hello from the failover test.",
    model: "primary-model",
    voice: "primary-voice",
    format: PCM16_16K_MONO,
    stream: true,
  };
}

function requestWithoutModelOrVoice(): TtsSynthesisRequest {
  const { model: _model, voice: _voice, ...value } = request();
  void _model;
  void _voice;
  return value;
}

function provider(
  name: string,
  synthesize: TextToSpeechProvider["synthesize"],
): TextToSpeechProvider {
  return {
    name,
    kind: "tts",
    version: "test",
    capabilities: CAPABILITIES,
    synthesize,
  };
}

function audioEvent(requestValue: TtsSynthesisRequest): TtsEvent {
  return createMediaEvent({
    id: "failover-audio" as never,
    type: "media.audio.chunk",
    sessionId: requestValue.sessionId,
    turnId: requestValue.turnId,
    sequence: 1,
    direction: "output",
    timestamp: nowTimestamp(),
    monotonicOffsetMs: 0,
    provider: "fallback-tts",
    audio: {
      format: PCM16_16K_MONO,
      durationMs: 20,
      frameCount: 320,
      bytes: new Uint8Array(640),
    },
  });
}

function alignmentEvent(
  requestValue: TtsSynthesisRequest,
  providerName: string,
): TtsAlignmentEvent {
  return {
    type: "tts.alignment",
    sessionId: requestValue.sessionId,
    turnId: requestValue.turnId,
    sequence: 1,
    provider: providerName,
    timestamp: nowTimestamp(),
    unit: "word",
    tokens: ["Hello"],
    startMs: [0],
    endMs: [100],
  };
}

function streamFrom(
  values: readonly TtsEvent[],
  failure?: unknown,
  onCancel?: () => void,
): TtsStream {
  return {
    events: {
      async *[Symbol.asyncIterator]() {
        for (const value of values) yield value;
        if (failure !== undefined) throw failure;
      },
    },
    async cancel() {
      onCancel?.();
    },
  };
}

async function collect(stream: TtsStream): Promise<TtsEvent[]> {
  const events: TtsEvent[] = [];
  for await (const event of stream.events) events.push(event);
  return events;
}

async function resolveWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`operation did not settle within ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("explicit TTS failover provider", () => {
  it("rejects call text controls before invoking either provider", async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const primary = provider("primary", async () => {
      primaryCalls += 1;
      return streamFrom([]);
    });
    const fallback = provider("fallback", async () => {
      fallbackCalls += 1;
      return streamFrom([]);
    });
    const failover = createTtsFailoverProvider({ primary, fallback });

    await expect(
      failover.synthesize({ ...request(), textNormalization: "off" }),
    ).rejects.toMatchObject({ code: TVIC_ERROR_CODES.providerInvalidRequest });
    expect(primaryCalls).toBe(0);
    expect(fallbackCalls).toBe(0);
  });

  it.each(["throws synchronously", "rejects asynchronously"] as const)(
    "reports Unicode text once per child invocation and forwards provider usage when the primary %s",
    async (failureMode) => {
      const primaryError = TvicThrowableError.from(
        providerError("provider.upstream_failed", "primary unavailable", {
          provider: "primary-tts",
          retriable: true,
        }),
      );
      const reportTextCharacters = vi.fn();
      const operationReports: Array<{ field: string; value: number }> = [];
      const beginOperation = vi.fn((input: Parameters<TtsUsageReporter["beginOperation"]>[0]) => ({
        report(value: number) {
          operationReports.push({ field: input.field, value });
        },
        notReported() {},
        finish() {},
      }));
      const usageReporter = {
        report: vi.fn(),
        beginOperation,
        reportTextCharacters,
      };
      const requestValue = {
        ...request(),
        text: "A😀e\u0301",
        usageReporter,
      };
      const primaryRequests: TtsSynthesisRequest[] = [];
      const fallbackRequests: TtsSynthesisRequest[] = [];
      const primary = {
        ...provider("primary-tts", (value) => {
          primaryRequests.push(value);
          value.usageReporter?.reportTextCharacters([...value.text].length);
          value.usageReporter?.report({
            field: "providerCharacterCount",
            status: "reported",
            value: 5,
            unit: "unicode_code_points",
            aggregation: "sum",
            model: "primary-model",
            modelSource: "provider_reported",
          });
          const usage = value.usageReporter?.beginOperation({
            field: "providerCharacterCount",
            unit: "provider_defined",
            aggregation: "sum",
            model: "primary-model",
          });
          usage?.report(5);
          usage?.finish();
          if (failureMode === "throws synchronously") throw primaryError;
          return Promise.reject(primaryError);
        }),
        usageAccounting: { reportsTextCharacters: true as const },
      } satisfies TextToSpeechProvider;
      const fallback = {
        ...provider("fallback-tts", async (value) => {
          fallbackRequests.push(value);
          value.usageReporter?.reportTextCharacters([...value.text].length);
          value.usageReporter?.report({
            field: "providerCharacterCount",
            status: "reported",
            value: 4,
            unit: "unicode_code_points",
            aggregation: "sum",
            model: "fallback-model",
            modelSource: "provider_reported",
          });
          const usage = value.usageReporter?.beginOperation({
            field: "providerCharacterCount",
            unit: "provider_defined",
            aggregation: "sum",
            model: "fallback-model",
          });
          usage?.report(4);
          usage?.finish();
          return streamFrom([]);
        }),
        usageAccounting: { reportsTextCharacters: true as const },
      } satisfies TextToSpeechProvider;

      const failover = createTtsFailoverProvider({ primary, fallback });

      expect(failover.usageAccounting).toEqual({
        reportsTextCharacters: true,
        usesRequestModelForUsage: true,
      });
      await collect(await failover.synthesize(requestValue));

      expect(reportTextCharacters.mock.calls).toEqual([[4], [4]]);
      expect(beginOperation.mock.calls).toEqual([
        [
          {
            field: "providerCharacterCount",
            unit: "provider_defined",
            aggregation: "sum",
            model: "primary-model",
          },
        ],
        [
          {
            field: "providerCharacterCount",
            unit: "provider_defined",
            aggregation: "sum",
            model: "fallback-model",
          },
        ],
      ]);
      expect(operationReports).toEqual([
        { field: "providerCharacterCount", value: 5 },
        { field: "providerCharacterCount", value: 4 },
      ]);
      expect(usageReporter.report.mock.calls).toEqual([
        [
          {
            field: "providerCharacterCount",
            status: "reported",
            value: 5,
            unit: "unicode_code_points",
            aggregation: "sum",
            model: "primary-model",
            modelSource: "provider_reported",
          },
        ],
        [
          {
            field: "providerCharacterCount",
            status: "reported",
            value: 4,
            unit: "unicode_code_points",
            aggregation: "sum",
            model: "fallback-model",
            modelSource: "provider_reported",
          },
        ],
      ]);
      expect(primaryRequests).toHaveLength(1);
      expect(fallbackRequests).toHaveLength(1);
      expect(primaryRequests[0]?.usageReporter).toBeDefined();
      expect(fallbackRequests[0]?.usageReporter).toBeDefined();
    },
  );

  it("counts every non-reporting child synthesis attempt, including failures", async () => {
    const reportTextCharacters = vi.fn();
    const primary = provider("primary-tts", async () => {
      throw TvicThrowableError.from(
        providerError("provider.upstream_failed", "primary could not connect", {
          provider: "primary-tts",
          retriable: true,
        }),
      );
    });
    const fallback = {
      ...provider("fallback-tts", async (value) => {
        const providerText = value.text.replace("&", "&amp;");
        value.usageReporter?.reportTextCharacters([...providerText].length);
        return streamFrom([]);
      }),
      usageAccounting: { reportsTextCharacters: true as const },
    } satisfies TextToSpeechProvider;
    const failover = createTtsFailoverProvider({ primary, fallback });

    await collect(
      await failover.synthesize({
        ...request(),
        text: "A & B",
        usageReporter: {
          report() {},
          beginOperation: () => ({ report() {}, notReported() {}, finish() {} }),
          reportTextCharacters,
        },
      }),
    );

    expect(reportTextCharacters.mock.calls).toEqual([[5], [9]]);
  });

  it("counts plain text at child invocation without character accounting", async () => {
    const reportTextCharacters = vi.fn();
    const primary = provider("primary-tts", async () => {
      throw TvicThrowableError.from(
        providerError("provider.upstream_failed", "primary could not connect", {
          provider: "primary-tts",
          retriable: true,
        }),
      );
    });
    const fallback = provider("fallback-tts", async () => {
      expect(reportTextCharacters).toHaveBeenCalledTimes(2);
      return streamFrom([]);
    });
    const failover = createTtsFailoverProvider({ primary, fallback });

    await collect(
      await failover.synthesize({
        ...request(),
        text: "A & B",
        usageReporter: {
          report() {},
          beginOperation: () => ({ report() {}, notReported() {}, finish() {} }),
          reportTextCharacters,
        },
      }),
    );

    expect(reportTextCharacters.mock.calls).toEqual([[5], [5]]);
  });

  it("maps Sarvam's request to ElevenLabs after a primary startup failure", async () => {
    const primaryError = TvicThrowableError.from(
      providerError("provider.upstream_failed", "Sarvam is unavailable", {
        provider: "sarvam-tts",
      }),
    );
    const calls: TtsSynthesisRequest[] = [];
    const fallbackContexts: string[] = [];
    const primary = {
      ...provider("sarvam-tts", async () => {
        throw primaryError;
      }),
      configuredLanguage: "en-IN",
    } satisfies TextToSpeechProvider;
    const fallback = provider("elevenlabs", async (value) => {
      calls.push(value);
      return streamFrom([]);
    });
    const mappedFallback = {
      ...fallback,
      configuredLanguage: "en-IN",
      capabilities: {
        ...CAPABILITIES,
        models: ["eleven_flash_v2_5"],
        voices: ["eleven-voice"],
      },
    } satisfies TextToSpeechProvider;
    const failover = createTtsFailoverProvider({
      primary,
      fallback: mappedFallback,
      mapFallbackRequest: (value) => ({
        ...value,
        model: "eleven_flash_v2_5",
        voice: "eleven-voice",
      }),
      fallbackRequestVariants: [
        { fallback: { model: "eleven_flash_v2_5", voice: "eleven-voice" } },
      ],
      onFallback: ({ phase, error }) => {
        fallbackContexts.push(`${phase}:${error.code}`);
      },
    });

    expect(failover.usageAccounting).toEqual({ reportsTextCharacters: true });

    expect(
      evaluateProviderCompatibility(failover, {
        kind: "tts",
        model: "primary-model",
        voice: "primary-voice",
      }),
    ).toMatchObject({ compatible: true });

    await collect(await failover.synthesize(request()));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      sessionId: "failover-session",
      turnId: "failover-turn",
      model: "eleven_flash_v2_5",
      voice: "eleven-voice",
    });
    expect(fallbackContexts).toEqual(["synthesize:provider.upstream_failed"]);
  });

  it("accepts a nested failover provider that preflights the complete fallback selection", async () => {
    const supportsHindi = (language: string): boolean => language === "hi-IN";
    const nestedPrimary = {
      ...provider("nested-primary", async () => streamFrom([])),
      configuredLanguage: "hi-IN",
      supportsTtsLanguage: supportsHindi,
    } satisfies TextToSpeechProvider;
    const nestedFallback = {
      ...provider("nested-fallback", async () => streamFrom([])),
      configuredLanguage: "hi-IN",
      supportsTtsLanguage: supportsHindi,
    } satisfies TextToSpeechProvider;
    const nested = createTtsFailoverProvider({
      primary: nestedPrimary,
      fallback: nestedFallback,
    });
    const primary = {
      ...provider("outer-primary", async () => {
        throw TvicThrowableError.from(
          providerError("provider.upstream_failed", "outer primary unavailable", {
            provider: "outer-primary",
          }),
        );
      }),
      configuredLanguage: "hi-IN",
      supportsTtsLanguage: supportsHindi,
    } satisfies TextToSpeechProvider;
    const failover = createTtsFailoverProvider({ primary, fallback: nested });

    expect(
      failover.supportsTtsSelection?.({
        model: "primary-model",
        voice: "primary-voice",
        language: "hi-IN",
      }),
    ).toBe(true);
    await expect(
      failover.synthesize({ ...request(), language: "hi-IN" }).then(collect),
    ).resolves.toEqual([]);
  });

  it("preflights every declared fallback language and speed variant", () => {
    const primary = {
      ...provider("primary-tts", async () => streamFrom([])),
      configuredModel: "primary-model",
      configuredVoice: "primary-voice",
      supportsTtsLanguage: (language: string) => language === "hi-IN",
      supportsTtsSpeed: (speed: number) => speed >= 0.5 && speed <= 1.5,
    } satisfies TextToSpeechProvider;
    const fallback = {
      ...provider("fallback-tts", async () => streamFrom([])),
      configuredModel: "fallback-model",
      configuredVoice: "fallback-voice",
      capabilities: {
        ...CAPABILITIES,
        models: ["fallback-model"],
        voices: ["fallback-voice"],
      },
      supportsTtsLanguage: (language: string) => language === "hi-IN",
      supportsTtsSpeed: (speed: number) => speed >= 0.7 && speed <= 1.2,
    } satisfies TextToSpeechProvider;
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      mapFallbackRequest: (value) => ({
        ...value,
        model: "fallback-model",
        voice: "fallback-voice",
      }),
      fallbackRequestVariants: [{ fallback: { model: "fallback-model", voice: "fallback-voice" } }],
    });

    expect(
      failover.supportsTtsSelection?.({
        model: "primary-model",
        voice: "primary-voice",
        language: "hi-IN",
        speed: 1.2,
      }),
    ).toBe(true);
    expect(
      failover.supportsTtsSelection?.({
        model: "primary-model",
        voice: "primary-voice",
        language: "hi-IN",
        speed: 1.5,
      }),
    ).toBe(false);
    expect(
      failover.supportsTtsSelection?.({
        model: "primary-model",
        voice: "primary-voice",
        language: "or-IN",
        speed: 1.2,
      }),
    ).toBe(false);
  });

  it.each([
    { model: "sonic-4", language: "en" },
    { model: "sonic-3.5", language: "or-IN" },
  ])(
    "rejects unsupported Cartesia fallback settings without speed: $model / $language",
    ({ model, language }) => {
      const primary = {
        ...provider("primary-tts", async () => streamFrom([])),
        configuredModel: "primary-model",
        configuredVoice: "primary-voice",
        configuredLanguage: "en",
        supportsTtsLanguage: (language: string) => language === "en",
      } satisfies TextToSpeechProvider;
      const fallback = createCartesiaTtsProvider({ apiKey: "test", voiceId: "cartesia-voice" });
      const fallbackSelection = { model, voice: "cartesia-voice", language };
      const failover = createTtsFailoverProvider({
        primary,
        fallback,
        mapFallbackRequest: (value) => ({ ...value, ...fallbackSelection }),
        fallbackRequestVariants: [{ fallback: fallbackSelection }],
      });

      expect(
        failover.supportsTtsSelection?.({ model: "primary-model", voice: "primary-voice" }),
      ).toBe(false);
    },
  );

  it("rejects a mapped failover without declared variants before the mapper or fallback runs", async () => {
    const primary = {
      ...provider("primary-tts", async () => {
        throw TvicThrowableError.from(
          providerError("provider.upstream_failed", "primary unavailable", {
            provider: "primary-tts",
          }),
        );
      }),
      configuredModel: "primary-model",
      configuredVoice: "primary-voice",
    } satisfies TextToSpeechProvider;
    let mapperCalls = 0;
    let fallbackCalls = 0;
    const fallback = provider("fallback-tts", async () => {
      fallbackCalls += 1;
      return streamFrom([]);
    });
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      mapFallbackRequest: (value) => {
        mapperCalls += 1;
        return { ...value, model: "fallback-model", voice: "fallback-voice" };
      },
    });

    expect(
      failover.supportsTtsSelection?.({
        model: "primary-model",
        voice: "primary-voice",
      }),
    ).toBe(false);
    await expect(failover.synthesize(request())).rejects.toThrow(
      "TTS failover mapping requires a declared fallback request variant for this selection",
    );
    expect(mapperCalls).toBe(0);
    expect(fallbackCalls).toBe(0);
  });

  it("rejects an error-dependent fallback mapping outside the declared variants", async () => {
    const primary = {
      ...provider("primary-tts", async () => {
        throw TvicThrowableError.from(
          providerError("provider.upstream_failed", "primary unavailable", {
            provider: "primary-tts",
          }),
        );
      }),
      configuredModel: "primary-model",
      configuredVoice: "primary-voice",
    } satisfies TextToSpeechProvider;
    let fallbackCalls = 0;
    const fallback = {
      ...provider("fallback-tts", async () => {
        fallbackCalls += 1;
        return streamFrom([]);
      }),
      configuredModel: "fallback-model",
      configuredVoice: "fallback-voice-a",
      capabilities: {
        ...CAPABILITIES,
        models: ["fallback-model"],
        voices: ["fallback-voice-a", "fallback-voice-b"],
      },
    } satisfies TextToSpeechProvider;
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      mapFallbackRequest: (value) => ({
        ...value,
        model: "fallback-model",
        voice: "fallback-voice-b",
      }),
      fallbackRequestVariants: [
        { fallback: { model: "fallback-model", voice: "fallback-voice-a" } },
      ],
    });

    await expect(failover.synthesize(request())).rejects.toThrow(
      "TTS failover mapping must produce one declared fallback request variant",
    );
    expect(fallbackCalls).toBe(0);
  });

  it("preserves the primary's configured model and voice for an identity-mapped fallback", async () => {
    const primaryError = TvicThrowableError.from(
      providerError("provider.upstream_failed", "primary unavailable", {
        provider: "primary-tts",
      }),
    );
    const primary = {
      ...provider("primary-tts", async () => {
        throw primaryError;
      }),
      configuredModel: "primary-model",
      configuredVoice: "primary-voice",
    } satisfies TextToSpeechProvider;
    const fallbackRequests: TtsSynthesisRequest[] = [];
    const fallback = {
      ...provider("fallback-tts", async (value) => {
        fallbackRequests.push(value);
        return streamFrom([]);
      }),
      configuredModel: "fallback-model",
      configuredVoice: "fallback-voice",
      capabilities: {
        ...CAPABILITIES,
        models: ["primary-model", "fallback-model"],
        voices: ["primary-voice", "fallback-voice"],
      },
    } satisfies TextToSpeechProvider;
    const failover = createTtsFailoverProvider({ primary, fallback });

    await collect(await failover.synthesize(requestWithoutModelOrVoice()));

    expect(fallbackRequests).toHaveLength(1);
    expect(fallbackRequests[0]).toMatchObject({
      model: "primary-model",
      voice: "primary-voice",
    });
  });

  it("preserves the primary's configured model provenance", () => {
    const primary = {
      ...provider("primary-tts", async () => streamFrom([])),
      configuredModel: "primary-model",
      configuredModelSource: "not_reported",
    } satisfies TextToSpeechProvider;
    const fallback = provider("fallback-tts", async () => streamFrom([]));

    const failover = createTtsFailoverProvider({ primary, fallback });

    expect(failover.configuredModelSource).toBe("not_reported");
  });

  it("preserves explicit unknown-model opt-in when both failover adapters allow it", async () => {
    const primaryError = TvicThrowableError.from(
      providerError("provider.upstream_failed", "primary unavailable", {
        provider: "primary-tts",
      }),
    );
    const primary = {
      ...provider("primary-tts", async () => {
        throw primaryError;
      }),
      configuredModel: "future-model",
      configuredVoice: "primary-voice",
      allowUnknownModel: true,
    } satisfies TextToSpeechProvider;
    const fallbackRequests: TtsSynthesisRequest[] = [];
    const fallback = {
      ...provider("fallback-tts", async (value) => {
        fallbackRequests.push(value);
        return streamFrom([]);
      }),
      capabilities: {
        ...CAPABILITIES,
        models: ["fallback-model"],
        voices: ["primary-voice"],
      },
      allowUnknownModel: true,
    } satisfies TextToSpeechProvider;
    const failover = createTtsFailoverProvider({ primary, fallback });

    expect(failover.allowUnknownModel).toBe(true);
    await collect(await failover.synthesize(requestWithoutModelOrVoice()));

    expect(fallbackRequests).toHaveLength(1);
    expect(fallbackRequests[0]).toMatchObject({ model: "future-model", voice: "primary-voice" });
  });

  it("rejects failover between explicitly configured different languages", () => {
    const primary = {
      ...provider("primary-tts", async () => streamFrom([])),
      configuredLanguage: "en-IN",
    } satisfies TextToSpeechProvider;
    const fallback = {
      ...provider("fallback-tts", async () => streamFrom([])),
      configuredLanguage: "hi-IN",
    } satisfies TextToSpeechProvider;

    expect(() => createTtsFailoverProvider({ primary, fallback })).toThrow(/language/u);
  });

  it("requires explicit opt-in to match locale and ISO language codes by base language", () => {
    const primary = {
      ...provider("sarvam-tts", async () => streamFrom([])),
      configuredLanguage: "en-IN",
    } satisfies TextToSpeechProvider;
    const fallback = {
      ...provider("elevenlabs", async () => streamFrom([])),
      configuredLanguage: "en",
    } satisfies TextToSpeechProvider;

    expect(() => createTtsFailoverProvider({ primary, fallback })).toThrow(
      /compatible configured languages/u,
    );
    expect(() =>
      createTtsFailoverProvider({ primary, fallback, languageMatch: "base-language" }),
    ).not.toThrow();
  });

  it("keeps the Sarvam-to-ElevenLabs example language-compatible", () => {
    const primary = createSarvamTtsRestProvider({
      apiKey: "sarvam-secret",
      language: "en-IN",
      voiceId: "simran_en_customer",
    });
    const fallback = createElevenLabsTtsHttpStreamProvider({
      apiKey: "elevenlabs-secret",
      language: "en",
      voiceId: "elevenlabs-voice",
    });

    expect(
      createTtsFailoverProvider({ primary, fallback, languageMatch: "base-language" })
        .configuredLanguage,
    ).toBe("en-IN");
  });

  it.each(["rest fetch", "rest body", "http-stream body"] as const)(
    "does not replay an ambiguous ElevenLabs %s failure under a custom fallback policy",
    async (failurePath) => {
      const model = "eleven_flash_v2_5";
      const voice = "elevenlabs-primary-voice";
      let fetchCalls = 0;
      let fallbackCalls = 0;
      const fetchImpl: typeof fetch = async () => {
        fetchCalls += 1;
        if (failurePath === "rest fetch") throw new TypeError("connection reset after dispatch");
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new TypeError("response body connection reset"));
            },
          }),
          { status: 200 },
        );
      };
      const primary =
        failurePath === "http-stream body"
          ? createElevenLabsTtsHttpStreamProvider({
              apiKey: "elevenlabs-secret",
              modelId: model,
              voiceId: voice,
              fetchImpl,
            })
          : createElevenLabsTtsRestProvider({
              apiKey: "elevenlabs-secret",
              modelId: model,
              voiceId: voice,
              fetchImpl,
            });
      const fallback = {
        ...provider("fallback-tts", async () => {
          fallbackCalls += 1;
          return streamFrom([]);
        }),
        capabilities: {
          ...CAPABILITIES,
          models: [model],
          voices: [voice],
        },
      } satisfies TextToSpeechProvider;
      const failover = createTtsFailoverProvider({
        primary,
        fallback,
        shouldFallback: () => true,
      });

      if (failurePath !== "http-stream body") {
        await expect(failover.synthesize(requestWithoutModelOrVoice())).rejects.toMatchObject({
          metadata: { outcomeUnknown: true },
        });
      } else {
        const stream = await failover.synthesize(requestWithoutModelOrVoice());
        await expect(collect(stream)).rejects.toMatchObject({
          metadata: { outcomeUnknown: true },
        });
      }

      expect(fetchCalls).toBe(1);
      expect(fallbackCalls).toBe(0);
    },
  );

  it.each(["primary", "fallback"] as const)(
    "rejects failover when only the %s declares a configured language",
    (languageOwner) => {
      const primary = {
        ...provider("primary-tts", async () => streamFrom([])),
        ...(languageOwner === "primary" ? { configuredLanguage: "hi-IN" } : {}),
      } satisfies TextToSpeechProvider;
      const fallback = {
        ...provider("fallback-tts", async () => streamFrom([])),
        ...(languageOwner === "fallback" ? { configuredLanguage: "hi-IN" } : {}),
      } satisfies TextToSpeechProvider;

      expect(() => createTtsFailoverProvider({ primary, fallback })).toThrow(
        /both declare compatible configured languages/u,
      );
    },
  );

  it("blocks fallback after Cartesia reports a 5xx after text submission", async () => {
    const socket = Object.assign(new EventEmitter(), {
      readyState: Number(WebSocket.OPEN),
      bufferedAmount: 0,
      send(data: string) {
        const message = JSON.parse(data) as {
          readonly transcript?: unknown;
          readonly context_id?: unknown;
        };
        if (typeof message.transcript !== "string" || message.transcript.length === 0) return;
        queueMicrotask(() =>
          socket.emit(
            "message",
            Buffer.from(
              JSON.stringify({
                type: "error",
                status_code: 500,
                error_code: "internal_server_error",
                message: "synthesis failed",
                context_id: message.context_id,
              }),
            ),
          ),
        );
      },
      close() {
        if (socket.readyState === WebSocket.CLOSED) return;
        socket.readyState = WebSocket.CLOSED;
        socket.emit("close", 1000, Buffer.alloc(0));
      },
    });
    const primary = createCartesiaTtsProvider({
      apiKey: "cartesia-secret",
      voiceId: "cartesia-voice",
      language: "en",
      webSocketFactory: () => {
        queueMicrotask(() => socket.emit("open"));
        return socket as never;
      },
    });
    let fallbackCalls = 0;
    const fallback = {
      ...provider("fallback-tts", async () => {
        fallbackCalls += 1;
        return streamFrom([]);
      }),
      configuredLanguage: "en",
    } satisfies TextToSpeechProvider;
    const failover = createTtsFailoverProvider({ primary, fallback });

    const stream = await failover.synthesize(requestWithoutModelOrVoice());

    await expect(collect(stream)).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerUpstreamFailed,
      retriable: false,
      metadata: { httpStatus: 500, outcomeUnknown: true },
    });
    expect(fallbackCalls).toBe(0);
  });

  it.each(["close", "socket error"] as const)(
    "blocks custom fallback policies after Cartesia %s after text submission",
    async (failureType) => {
      const socket = Object.assign(new EventEmitter(), {
        readyState: Number(WebSocket.OPEN),
        bufferedAmount: 0,
        send(data: string) {
          const message = JSON.parse(data) as { readonly transcript?: unknown };
          if (typeof message.transcript !== "string" || message.transcript.length === 0) return;
          queueMicrotask(() => {
            if (failureType === "close") {
              socket.readyState = WebSocket.CLOSED;
              socket.emit("close", 1006, Buffer.alloc(0));
            } else {
              socket.emit("error", new Error("connection reset"));
            }
          });
        },
        close() {
          socket.readyState = WebSocket.CLOSED;
        },
      });
      const primary = createCartesiaTtsProvider({
        apiKey: "cartesia-secret",
        voiceId: "cartesia-voice",
        language: "en",
        webSocketFactory: () => {
          queueMicrotask(() => socket.emit("open"));
          return socket as never;
        },
      });
      let fallbackCalls = 0;
      const fallback = {
        ...provider("fallback-tts", async () => {
          fallbackCalls += 1;
          return streamFrom([]);
        }),
        capabilities: {
          ...CAPABILITIES,
          models: ["sonic-3.6"],
          voices: ["cartesia-voice"],
        },
        configuredLanguage: "en",
      } satisfies TextToSpeechProvider;
      const failover = createTtsFailoverProvider({
        primary,
        fallback,
        shouldFallback: () => true,
      });

      const stream = await failover.synthesize(requestWithoutModelOrVoice());

      await expect(collect(stream)).rejects.toMatchObject({
        retriable: false,
        metadata: { outcomeUnknown: true },
      });
      expect(fallbackCalls).toBe(0);
    },
  );

  it("preserves Sarvam's effective V3 voice on identity failover without choosing a V4 persona", async () => {
    const primaryError = TvicThrowableError.from(
      providerError("provider.upstream_failed", "primary unavailable", {
        provider: "sarvam-tts",
        retriable: true,
      }),
    );
    const sarvamPrimary = createSarvamTtsProvider({
      apiKey: "sarvam-secret",
      language: "en-IN",
      webSocketFactory: () => {
        throw new Error("unused WebSocket factory");
      },
    });
    const primary = {
      ...sarvamPrimary,
      configuredModel: sarvamPrimary.configuredModel,
      configuredVoice: sarvamPrimary.configuredVoice,
      async synthesize() {
        throw primaryError;
      },
    } satisfies TextToSpeechProvider;
    const fallbackRequests: TtsSynthesisRequest[] = [];
    const fallback = {
      ...provider("fallback-tts", async (value) => {
        fallbackRequests.push(value);
        return streamFrom([]);
      }),
      capabilities: {
        ...CAPABILITIES,
        models: ["bulbul:v3"],
        voices: ["shubh"],
      },
    } satisfies TextToSpeechProvider;
    const v4WithoutPersona = createSarvamTtsProvider({
      apiKey: "sarvam-secret",
      modelId: "bulbul:v4-flash",
      language: "en-IN",
      webSocketFactory: () => {
        throw new Error("unused WebSocket factory");
      },
    });

    expect(v4WithoutPersona.configuredVoice).toBeUndefined();
    await collect(
      await createTtsFailoverProvider({ primary, fallback }).synthesize(
        requestWithoutModelOrVoice(),
      ),
    );

    expect(fallbackRequests).toHaveLength(1);
    expect(fallbackRequests[0]).toMatchObject({ model: "bulbul:v3", voice: "shubh" });
  });

  it("never replays a synthesis with an unknown outcome, even when policy opts in", async () => {
    const primaryError = TvicThrowableError.from(
      providerError("provider.upstream_failed", "connection closed after submission", {
        provider: "sarvam-tts",
        retriable: false,
        metadata: { outcomeUnknown: true },
      }),
    );
    let fallbackCalls = 0;
    const primary = {
      ...provider("sarvam-tts", async () => {
        throw primaryError;
      }),
      configuredLanguage: "en-IN",
    } satisfies TextToSpeechProvider;
    const fallback = {
      ...provider("elevenlabs", async () => {
        fallbackCalls += 1;
        return streamFrom([]);
      }),
      configuredLanguage: "en-IN",
    } satisfies TextToSpeechProvider;

    await expect(
      createTtsFailoverProvider({
        primary,
        fallback,
        shouldFallback: () => true,
      }).synthesize(request()),
    ).rejects.toBe(primaryError);
    expect(fallbackCalls).toBe(0);
  });

  it("blocks fallback when Sarvam closes after accepting the startup text", async () => {
    const socket = Object.assign(new EventEmitter(), {
      readyState: Number(WebSocket.OPEN),
      bufferedAmount: 0,
      send(data: string) {
        if ((JSON.parse(data) as { type: string }).type === "text") {
          queueMicrotask(() => socket.emit("close", 1006, Buffer.alloc(0)));
        }
      },
      close() {
        if (socket.readyState === WebSocket.CLOSED) return;
        socket.readyState = WebSocket.CLOSED;
        socket.emit("close", 1000, Buffer.alloc(0));
      },
    });
    const primary = createSarvamTtsProvider({
      apiKey: "sarvam-secret",
      modelId: "bulbul:v3",
      language: "en-IN",
      webSocketFactory: () => socket as never,
    });
    let fallbackCalls = 0;
    const fallback = {
      ...provider("elevenlabs", async () => {
        fallbackCalls += 1;
        return streamFrom([]);
      }),
      configuredLanguage: "en-IN",
    } satisfies TextToSpeechProvider;

    const stream = await createTtsFailoverProvider({
      primary,
      fallback,
      shouldFallback: () => true,
    }).synthesize({ ...request(), model: "bulbul:v3", voice: "shubh" });

    await expect(collect(stream)).rejects.toMatchObject({
      retriable: false,
      metadata: { outcomeUnknown: true },
    });
    expect(fallbackCalls).toBe(0);
  });

  it("blocks ElevenLabs fallback after the provider accepted text but closed before audio", async () => {
    const socket = Object.assign(new EventEmitter(), {
      readyState: Number(WebSocket.OPEN),
      bufferedAmount: 0,
      send(data: string) {
        const message = JSON.parse(data) as { readonly text?: unknown };
        if (typeof message.text === "string" && message.text.length > 0 && message.text !== " ") {
          queueMicrotask(() => socket.emit("close", 1006, Buffer.alloc(0)));
        }
      },
      close() {
        if (socket.readyState === WebSocket.CLOSED) return;
        socket.readyState = WebSocket.CLOSED;
        socket.emit("close", 1000, Buffer.alloc(0));
      },
    });
    const primary = createElevenLabsTtsProvider({
      apiKey: "eleven-secret",
      modelId: "eleven_flash_v2_5",
      voiceId: "voice-primary",
      webSocketFactory: () => socket as never,
    });
    let fallbackCalls = 0;
    const fallback = {
      ...provider("fallback-tts", async () => {
        fallbackCalls += 1;
        return streamFrom([]);
      }),
      capabilities: {
        ...CAPABILITIES,
        models: ["eleven_flash_v2_5"],
        voices: ["voice-primary"],
      },
    } satisfies TextToSpeechProvider;
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      shouldFallback: () => true,
    });
    const stream = await failover.synthesize({
      ...request(),
      model: "eleven_flash_v2_5",
      voice: "voice-primary",
    });

    await expect(collect(stream)).rejects.toMatchObject({
      code: "tts.transport.unexpected_eof",
      retriable: false,
      metadata: { outcomeUnknown: true },
    });
    expect(fallbackCalls).toBe(0);
  });

  it.each([408, 409, 500, 503])(
    "does not fail over on ElevenLabs HTTP %s after synthesis may have been accepted",
    async (status) => {
      const primary = createElevenLabsTtsRestProvider({
        apiKey: "eleven-secret",
        modelId: "eleven_flash_v2_5",
        voiceId: "voice-primary",
        fetchImpl: async () =>
          new Response(JSON.stringify({ detail: { message: "quota exceeded" } }), { status }),
      });
      let fallbackCalls = 0;
      const fallback = {
        ...provider("fallback-tts", async () => {
          fallbackCalls += 1;
          return streamFrom([]);
        }),
        capabilities: {
          ...CAPABILITIES,
          models: ["eleven_flash_v2_5"],
          voices: ["voice-primary"],
        },
      } satisfies TextToSpeechProvider;
      const failover = createTtsFailoverProvider({
        primary,
        fallback,
        shouldFallback: () => true,
      });

      await expect(
        failover.synthesize({
          ...request(),
          model: "eleven_flash_v2_5",
          voice: "voice-primary",
        }),
      ).rejects.toMatchObject({
        code: TVIC_ERROR_CODES.providerUpstreamFailed,
        retriable: false,
        metadata: { httpStatus: status, outcomeUnknown: true },
      });
      expect(fallbackCalls).toBe(0);
    },
  );

  it("does not default to fallback for a non-retriable provider error", async () => {
    const primaryError = TvicThrowableError.from(
      providerError("provider.sarvam.tts.error", "permanent provider failure", {
        provider: "sarvam-tts",
        retriable: false,
      }),
    );
    let fallbackCalls = 0;
    const primary = {
      ...provider("sarvam-tts", async () => {
        throw primaryError;
      }),
      configuredLanguage: "en-IN",
    } satisfies TextToSpeechProvider;
    const fallback = {
      ...provider("elevenlabs", async () => {
        fallbackCalls += 1;
        return streamFrom([]);
      }),
      configuredLanguage: "en-IN",
    } satisfies TextToSpeechProvider;

    await expect(
      createTtsFailoverProvider({ primary, fallback }).synthesize(request()),
    ).rejects.toBe(primaryError);
    expect(fallbackCalls).toBe(0);
  });

  it("does not replay when a primary stream fails with an unknown outcome before audio", async () => {
    const primaryError = TvicThrowableError.from(
      providerError("provider.upstream_failed", "socket closed after text submission", {
        provider: "sarvam-tts",
        retriable: false,
        metadata: { outcomeUnknown: true },
      }),
    );
    let fallbackCalls = 0;
    const primary = provider("sarvam-tts", async () => streamFrom([], primaryError));
    const fallback = provider("elevenlabs", async () => {
      fallbackCalls += 1;
      return streamFrom([]);
    });
    const stream = await createTtsFailoverProvider({ primary, fallback }).synthesize(request());

    await expect(collect(stream)).rejects.toBe(primaryError);
    expect(fallbackCalls).toBe(0);
  });

  it("fails over a stream that dies before emitting audio", async () => {
    let primaryCancelled = false;
    let fallbackCalls = 0;
    const primary = provider("sarvam-tts", async () =>
      streamFrom(
        [],
        TvicThrowableError.from(
          providerError("provider.sarvam.tts.error", "socket closed", {
            provider: "sarvam-tts",
          }),
        ),
        () => {
          primaryCancelled = true;
        },
      ),
    );
    const fallback = provider("elevenlabs", async () => {
      fallbackCalls += 1;
      return streamFrom([]);
    });
    const failover = createTtsFailoverProvider({ primary, fallback });

    await collect(await failover.synthesize(request()));

    expect(primaryCancelled).toBe(true);
    expect(fallbackCalls).toBe(1);
  });

  it("does not mix primary alignment events into fallback audio", async () => {
    const primaryError = TvicThrowableError.from(
      providerError("provider.sarvam.tts.error", "socket closed", {
        provider: "sarvam-tts",
      }),
    );
    const primary = provider("sarvam-tts", async () =>
      streamFrom([alignmentEvent(request(), "sarvam-tts")], primaryError),
    );
    const fallbackEvents = [alignmentEvent(request(), "elevenlabs"), audioEvent(request())];
    const fallback = provider("elevenlabs", async () => streamFrom(fallbackEvents));

    const events = await collect(
      await createTtsFailoverProvider({ primary, fallback }).synthesize(request()),
    );

    expect(events).toEqual(fallbackEvents);
  });

  it("keeps primary pre-audio events in order when the primary succeeds", async () => {
    const primaryEvents = [alignmentEvent(request(), "sarvam-tts"), audioEvent(request())];
    const primary = provider("sarvam-tts", async () => streamFrom(primaryEvents));
    const fallback = provider("elevenlabs", async () => streamFrom([]));

    const events = await collect(
      await createTtsFailoverProvider({ primary, fallback }).synthesize(request()),
    );

    expect(events).toEqual(primaryEvents);
  });

  it("bounds pre-audio event buffering and stops failover after releasing primary events", async () => {
    const requestValue = request();
    const oversizedEvent: TtsAlignmentEvent = {
      ...alignmentEvent(requestValue, "sarvam-tts"),
      tokens: ["x".repeat(1_100_000)],
    };
    const primary = provider("sarvam-tts", async () =>
      streamFrom(
        [oversizedEvent],
        TvicThrowableError.from(
          providerError("provider.sarvam.tts.error", "socket closed", {
            provider: "sarvam-tts",
          }),
        ),
      ),
    );
    let fallbackCalls = 0;
    const fallback = provider("elevenlabs", async () => {
      fallbackCalls += 1;
      return streamFrom([]);
    });
    const stream = await createTtsFailoverProvider({ primary, fallback }).synthesize(requestValue);
    const iterator = stream.events[Symbol.asyncIterator]();
    const stringify = vi.spyOn(JSON, "stringify");

    try {
      expect((await iterator.next()).value).toBe(oversizedEvent);
      await expect(iterator.next()).rejects.toMatchObject({ code: "provider.sarvam.tts.error" });
      expect(fallbackCalls).toBe(0);
      expect(stringify.mock.calls.some(([value]) => value === oversizedEvent)).toBe(false);
    } finally {
      stringify.mockRestore();
    }
  });

  it("does not advertise incremental input that the failover wrapper cannot expose", () => {
    const primary = {
      ...provider("sarvam-tts", async () => streamFrom([])),
      capabilities: {
        ...CAPABILITIES,
        streaming: { ...CAPABILITIES.streaming, input: true },
      },
    };
    const fallback = provider("elevenlabs", async () => streamFrom([]));
    const failover = createTtsFailoverProvider({ primary, fallback });

    expect(failover.capabilities.streaming.input).toBe(false);
    expect(isIncrementalTextToSpeechProvider(failover)).toBe(false);
    expect(
      evaluateProviderCompatibility(failover, {
        kind: "tts",
        streaming: { input: true },
      }),
    ).toMatchObject({
      compatible: false,
      issues: [{ code: "streaming.unsupported", requirement: "streaming.input" }],
    });
  });

  it("advertises only cancellation guarantees shared by both providers", () => {
    const primary = {
      ...provider("sarvam-tts", async () => streamFrom([])),
      capabilities: {
        ...CAPABILITIES,
        cancellation: { request: true, output: true, buffer: true, truncation: true },
      },
    };
    const fallback = {
      ...provider("elevenlabs", async () => streamFrom([])),
      capabilities: {
        ...CAPABILITIES,
        cancellation: { request: false, output: false, buffer: true, truncation: false },
      },
    };
    const failover = createTtsFailoverProvider({ primary, fallback });

    expect(failover.capabilities.cancellation).toEqual({
      request: false,
      output: false,
      buffer: true,
      truncation: false,
    });
    expect(
      evaluateProviderCompatibility(failover, {
        kind: "tts",
        cancellation: { request: true },
      }),
    ).toMatchObject({
      compatible: false,
      issues: [{ code: "cancellation.unsupported", requirement: "cancellation.request" }],
    });
  });

  it("does not advertise timestamp support unless the fallback can honor it", async () => {
    const primaryError = TvicThrowableError.from(
      providerError("provider.upstream_failed", "primary is unavailable", {
        provider: "primary-tts",
      }),
    );
    const primary = {
      ...provider("primary-tts", async () => {
        throw primaryError;
      }),
      capabilities: { ...CAPABILITIES, timestamps: true },
    };
    let fallbackCalls = 0;
    const fallback = {
      ...provider("sarvam-tts", async () => {
        fallbackCalls += 1;
        return streamFrom([]);
      }),
      capabilities: { ...CAPABILITIES, timestamps: false },
    };
    const failover = createTtsFailoverProvider({ primary, fallback });

    expect(failover.capabilities.timestamps).toBe(false);
    await expect(failover.synthesize({ ...request(), timestamps: true })).rejects.toBe(
      primaryError,
    );
    expect(fallbackCalls).toBe(0);
  });

  it("does not replay a turn after audio has already been delivered", async () => {
    let fallbackCalls = 0;
    const primary = provider("sarvam-tts", async (value) =>
      streamFrom(
        [audioEvent(value)],
        TvicThrowableError.from(
          providerError("provider.sarvam.tts.error", "socket closed after audio", {
            provider: "sarvam-tts",
          }),
        ),
      ),
    );
    const fallback = provider("elevenlabs", async () => {
      fallbackCalls += 1;
      return streamFrom([]);
    });
    const failover = createTtsFailoverProvider({ primary, fallback });

    await expect(collect(await failover.synthesize(request()))).rejects.toMatchObject({
      code: "provider.sarvam.tts.error",
    });
    expect(fallbackCalls).toBe(0);
  });

  it("does not hide invalid requests or caller cancellation", async () => {
    const invalidPrimary = provider("sarvam-tts", async () => {
      throw TvicThrowableError.from(
        validationError("provider.invalid_request", "Sarvam rejected the request"),
      );
    });
    const cancelledPrimary = provider("sarvam-tts", async () => {
      throw TvicThrowableError.from(
        providerError("provider.connection_cancelled", "request cancelled", {
          provider: "sarvam-tts",
          retriable: false,
        }),
      );
    });
    let fallbackCalls = 0;
    const fallback = provider("elevenlabs", async () => {
      fallbackCalls += 1;
      return streamFrom([]);
    });

    await expect(
      Promise.resolve().then(async () =>
        collect(
          await createTtsFailoverProvider({
            primary: invalidPrimary,
            fallback,
          }).synthesize(request()),
        ),
      ),
    ).rejects.toMatchObject({ code: "provider.invalid_request" });

    const controller = new AbortController();
    controller.abort();
    await expect(
      Promise.resolve().then(() =>
        createTtsFailoverProvider({ primary: cancelledPrimary, fallback }).synthesize({
          ...request(),
          signal: controller.signal,
        }),
      ),
    ).rejects.toMatchObject({ code: "provider.connection_cancelled" });

    expect(fallbackCalls).toBe(0);
  });

  it("does not hide a permanent Sarvam HTTP 404 behind fallback audio", async () => {
    let fallbackCalls = 0;
    const primary = createSarvamTtsRestProvider({
      apiKey: "sarvam-secret",
      modelId: "bulbul:v3",
      language: "en-IN",
      fetchImpl: async () => new Response("not found", { status: 404 }),
    });
    const fallback = {
      ...provider("elevenlabs", async () => {
        fallbackCalls += 1;
        return streamFrom([]);
      }),
      configuredLanguage: "en-IN",
    } satisfies TextToSpeechProvider;

    await expect(
      createTtsFailoverProvider({ primary, fallback }).synthesize({
        ...request(),
        model: "bulbul:v3",
        voice: "shubh",
      }),
    ).rejects.toMatchObject({ code: TVIC_ERROR_CODES.providerInvalidRequest });
    expect(fallbackCalls).toBe(0);
  });

  it("does not mask malformed provider protocol responses with fallback", async () => {
    let fallbackCalls = 0;
    const primary = provider("sarvam-tts", async () => {
      throw TvicThrowableError.from(
        providerError(TVIC_ERROR_CODES.providerProtocolInvalid, "malformed audio response", {
          provider: "sarvam-tts",
          retriable: false,
        }),
      );
    });
    const fallback = provider("elevenlabs", async () => {
      fallbackCalls += 1;
      return streamFrom([]);
    });

    await expect(
      createTtsFailoverProvider({ primary, fallback }).synthesize(request()),
    ).rejects.toMatchObject({ code: TVIC_ERROR_CODES.providerProtocolInvalid });
    expect(fallbackCalls).toBe(0);
  });

  it("does not start fallback when the fallback observer aborts the request", async () => {
    const controller = new AbortController();
    const primary = provider("sarvam-tts", async () => {
      throw TvicThrowableError.from(
        providerError("provider.upstream_failed", "primary unavailable", {
          provider: "sarvam-tts",
        }),
      );
    });
    let fallbackCalls = 0;
    const fallback = provider("elevenlabs", async () => {
      fallbackCalls += 1;
      return streamFrom([]);
    });
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      onFallback: () => controller.abort(),
    });

    await expect(
      failover.synthesize({ ...request(), signal: controller.signal }),
    ).rejects.toMatchObject({
      code: "provider.connection_cancelled",
    });
    expect(fallbackCalls).toBe(0);
  });

  it("cancels a fallback stream that starts after the caller aborts", async () => {
    const controller = new AbortController();
    const primary = provider("sarvam-tts", async () => {
      throw TvicThrowableError.from(
        providerError("provider.upstream_failed", "primary unavailable", {
          provider: "sarvam-tts",
        }),
      );
    });
    let resolveFallback!: (stream: TtsStream) => void;
    let markFallbackStarted!: () => void;
    let markFallbackCancelled!: () => void;
    let fallbackCancelled = false;
    const fallbackStarted = new Promise<void>((resolve) => {
      markFallbackStarted = resolve;
    });
    const fallbackCancellationStarted = new Promise<void>((resolve) => {
      markFallbackCancelled = resolve;
    });
    const fallback = provider("elevenlabs", async () => {
      markFallbackStarted();
      return new Promise<TtsStream>((resolve) => {
        resolveFallback = resolve;
      });
    });

    const pending = createTtsFailoverProvider({ primary, fallback }).synthesize({
      ...request(),
      signal: controller.signal,
    });
    await fallbackStarted;
    controller.abort();
    await expect(resolveWithin(pending, 100)).rejects.toMatchObject({
      code: "provider.connection_cancelled",
    });
    resolveFallback(
      streamFrom([], undefined, () => {
        fallbackCancelled = true;
        markFallbackCancelled();
      }),
    );

    await fallbackCancellationStarted;
    expect(fallbackCancelled).toBe(true);
  });

  it("cancels pending fallback startup when the returned stream is cancelled", async () => {
    const primaryError = TvicThrowableError.from(
      providerError("provider.upstream_failed", "primary stream failed", {
        provider: "sarvam-tts",
      }),
    );
    let rejectPrimary!: (error: unknown) => void;
    let resolveFallback!: (stream: TtsStream) => void;
    let markReadStarted!: () => void;
    let markFallbackStarted!: () => void;
    let markFallbackCancelled!: () => void;
    let fallbackSignal: AbortSignal | undefined;
    let fallbackCancelCalls = 0;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    const fallbackStarted = new Promise<void>((resolve) => {
      markFallbackStarted = resolve;
    });
    const fallbackCancelled = new Promise<void>((resolve) => {
      markFallbackCancelled = resolve;
    });
    const primary = provider("sarvam-tts", async () => ({
      events: {
        [Symbol.asyncIterator](): AsyncIterator<TtsEvent> {
          return {
            next() {
              markReadStarted();
              return new Promise<IteratorResult<TtsEvent>>((_resolve, reject) => {
                rejectPrimary = reject;
              });
            },
            async return() {
              return { done: true, value: undefined as never };
            },
          };
        },
      },
      async cancel() {},
    }));
    const fallback = provider("elevenlabs", async (fallbackRequest) => {
      fallbackSignal = fallbackRequest.signal;
      markFallbackStarted();
      return new Promise<TtsStream>((resolve) => {
        resolveFallback = resolve;
      });
    });
    const stream = await createTtsFailoverProvider({ primary, fallback }).synthesize(request());
    const iterator = stream.events[Symbol.asyncIterator]();
    const pendingEvent = iterator.next();
    await readStarted;
    rejectPrimary(primaryError);
    await fallbackStarted;

    const cancellation = stream.cancel();
    await expect(resolveWithin(pendingEvent, 100)).rejects.toMatchObject({
      code: "provider.connection_cancelled",
    });
    await cancellation;
    expect(fallbackSignal?.aborted).toBe(true);

    resolveFallback(
      streamFrom([], undefined, () => {
        fallbackCancelCalls += 1;
        markFallbackCancelled();
      }),
    );
    await fallbackCancelled;
    expect(fallbackCancelCalls).toBe(1);
  });

  it("cancels a primary stream that resolves after the caller aborts", async () => {
    const controller = new AbortController();
    let resolvePrimary!: (stream: TtsStream) => void;
    let markPrimaryCancelled!: () => void;
    let primaryCancelled = false;
    const primaryCancellationStarted = new Promise<void>((resolve) => {
      markPrimaryCancelled = resolve;
    });
    const primary = provider(
      "primary-tts",
      async () =>
        new Promise<TtsStream>((resolve) => {
          resolvePrimary = resolve;
        }),
    );
    const fallback = provider("fallback-tts", async () => streamFrom([]));
    const pending = createTtsFailoverProvider({ primary, fallback }).synthesize({
      ...request(),
      signal: controller.signal,
    });

    controller.abort();
    await expect(resolveWithin(pending, 100)).rejects.toMatchObject({
      code: "provider.connection_cancelled",
    });
    resolvePrimary(
      streamFrom([], undefined, () => {
        primaryCancelled = true;
        markPrimaryCancelled();
      }),
    );

    await primaryCancellationStarted;
    expect(primaryCancelled).toBe(true);
  });

  it("bounds cancellation when an active provider never cancels or closes its iterator", async () => {
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    let cancelCalled = false;
    let returnCalled = false;
    const primary = provider("primary-tts", async () => ({
      events: {
        [Symbol.asyncIterator]() {
          return {
            next() {
              markReadStarted();
              return new Promise<IteratorResult<TtsEvent>>(() => undefined);
            },
            return() {
              returnCalled = true;
              return new Promise<IteratorResult<TtsEvent>>(() => undefined);
            },
          };
        },
      },
      async cancel() {
        cancelCalled = true;
        await new Promise<void>(() => undefined);
      },
    }));
    const fallback = provider("fallback-tts", async () => streamFrom([]));
    const stream = await createTtsFailoverProvider({ primary, fallback }).synthesize(request());
    const consumerRead = stream.events[Symbol.asyncIterator]().next();
    await readStarted;

    await expect(
      Promise.race([
        stream.cancel(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("failover cancellation was unbounded")), 1_500),
        ),
      ]),
    ).resolves.toBeUndefined();
    await expect(resolveWithin(consumerRead, 100)).rejects.toMatchObject({
      code: "provider.connection_cancelled",
    });
    expect(cancelCalled).toBe(true);
    expect(returnCalled).toBe(true);
  });

  it("recovers to fallback when primary cleanup never settles", async () => {
    const primaryError = TvicThrowableError.from(
      providerError("provider.upstream_failed", "primary stream failed", {
        provider: "primary-tts",
      }),
    );
    let rejectPrimary!: (error: unknown) => void;
    let markReadStarted!: () => void;
    let fallbackCalls = 0;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    const primary = provider("primary-tts", async () => ({
      events: {
        [Symbol.asyncIterator](): AsyncIterator<TtsEvent> {
          return {
            next() {
              markReadStarted();
              return new Promise<IteratorResult<TtsEvent>>((_resolve, reject) => {
                rejectPrimary = reject;
              });
            },
            return() {
              return new Promise<IteratorResult<TtsEvent>>(() => undefined);
            },
          };
        },
      },
      async cancel() {
        await new Promise<void>(() => undefined);
      },
    }));
    const fallback = provider("fallback-tts", async () => {
      fallbackCalls += 1;
      return streamFrom([]);
    });
    const stream = await createTtsFailoverProvider({ primary, fallback }).synthesize(request());
    const observed = collect(stream);
    await readStarted;
    rejectPrimary(primaryError);

    await expect(observed).resolves.toEqual([]);
    expect(fallbackCalls).toBe(1);
  });

  it("keeps the provider output contract compatible", () => {
    const primary = provider("sarvam-tts", async () => streamFrom([]));
    const fallback = provider("elevenlabs", async () => streamFrom([]));
    const failover = createTtsFailoverProvider({ primary, fallback });

    expect(failover.kind).toBe("tts");
    expect(failover.capabilities.audio?.output).toEqual([PCM16_16K_MONO]);
    expect(failover.capabilities.metadata).toMatchObject({
      failover: { primary: "sarvam-tts", fallback: "elevenlabs" },
    });
  });

  it("does not advertise or invoke an identity-mapped fallback outside shared catalogs", async () => {
    const primaryError = TvicThrowableError.from(
      providerError("provider.upstream_failed", "primary is unavailable", {
        provider: "sarvam-tts",
      }),
    );
    const primary = {
      ...provider("sarvam-tts", async () => {
        throw primaryError;
      }),
      capabilities: {
        ...CAPABILITIES,
        languages: ["en-IN"],
        models: ["bulbul:v4-flash"],
        voices: ["simran_en_customer"],
      },
      configuredModel: "bulbul:v4-flash",
      configuredVoice: "simran_en_customer",
    } satisfies TextToSpeechProvider;
    let fallbackCalls = 0;
    const fallback = {
      ...provider("elevenlabs", async () => {
        fallbackCalls += 1;
        return streamFrom([]);
      }),
      capabilities: {
        ...CAPABILITIES,
        languages: ["hi-IN"],
        models: ["eleven_flash_v2_5"],
        voices: ["eleven-voice"],
      },
      configuredModel: "eleven_flash_v2_5",
      configuredVoice: "eleven-voice",
    } satisfies TextToSpeechProvider;
    const failover = createTtsFailoverProvider({ primary, fallback });
    const requirements = {
      kind: "tts" as const,
      language: "en-IN",
      model: "bulbul:v4-flash",
      voice: "simran_en_customer",
    };

    expect(evaluateProviderCompatibility(failover, requirements)).toMatchObject({
      compatible: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "language.unsupported" }),
        expect.objectContaining({ code: TVIC_ERROR_CODES.providerModelUnsupported }),
        expect.objectContaining({ code: TVIC_ERROR_CODES.providerVoiceUnsupported }),
      ]),
    });
    await expect(
      failover.synthesize({
        ...request(),
        model: "bulbul:v4-flash",
        voice: "simran_en_customer",
      }),
    ).rejects.toBeDefined();
    expect(fallbackCalls).toBe(0);
  });

  it("validates mapped model and voice values against fallback catalogs before synthesis", async () => {
    const primaryError = TvicThrowableError.from(
      providerError("provider.upstream_failed", "primary is unavailable", {
        provider: "sarvam-tts",
      }),
    );
    const primary = {
      ...provider("sarvam-tts", async () => {
        throw primaryError;
      }),
      capabilities: {
        ...CAPABILITIES,
        models: ["bulbul:v4-flash"],
        voices: ["simran_en_customer"],
      },
    } satisfies TextToSpeechProvider;
    let fallbackCalls = 0;
    const fallback = {
      ...provider("elevenlabs", async () => {
        fallbackCalls += 1;
        return streamFrom([]);
      }),
      capabilities: {
        ...CAPABILITIES,
        models: ["eleven_flash_v2_5"],
        voices: ["eleven-voice"],
      },
    } satisfies TextToSpeechProvider;
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      mapFallbackRequest: (value) => ({
        ...value,
        model: "unsupported-model",
        voice: "unsupported-voice",
      }),
      fallbackRequestVariants: [
        { fallback: { model: "unsupported-model", voice: "unsupported-voice" } },
      ],
    });

    await expect(
      failover.synthesize({ ...request(), model: "bulbul:v4-flash", voice: "simran_en_customer" }),
    ).rejects.toMatchObject({ code: TVIC_ERROR_CODES.providerModelUnsupported });
    expect(fallbackCalls).toBe(0);
  });

  it("uses the call-pinned time when validating an expired fallback account catalog", async () => {
    const now = Date.now();
    const validatedAt = new Date(now - 2 * 60_000).toISOString() as NonNullable<
      TtsSynthesisRequest["speechControlCatalogValidatedAt"]
    >;
    const catalog = createSpeechControlCatalogSnapshot(
      [
        {
          provider: "account-fallback",
          control: "tts.voice",
          scope: { type: "account", model: "primary-model", voice: "primary-voice" },
          status: "supported",
          mutability: "provider",
          source: "https://provider.example/voices",
          verifiedAt: "2026-10-25",
        },
      ],
      {
        fetchedAt: new Date(now - 3 * 60_000).toISOString(),
        validUntil: new Date(now - 60_000).toISOString(),
      },
    );
    const primary = provider("primary-tts", async () => {
      throw TvicThrowableError.from(
        providerError("provider.upstream_failed", "primary is unavailable", {
          provider: "primary-tts",
        }),
      );
    });
    let fallbackCalls = 0;
    const fallback = {
      ...provider("account-fallback", async (requestValue) => {
        fallbackCalls += 1;
        expect(requestValue.speechControlCatalog).toBe(catalog);
        expect(requestValue.speechControlCatalogValidatedAt).toBe(validatedAt);
        return streamFrom([]);
      }),
      requiresAccountVoiceCatalog: true,
      supportsTtsSelection: (selection: {
        readonly model?: string;
        readonly voice?: string;
        readonly speechControlCatalog?: typeof catalog;
        readonly speechControlCatalogValidatedAt?: TtsSynthesisRequest["speechControlCatalogValidatedAt"];
      }) =>
        selection.speechControlCatalog !== undefined &&
        selection.model !== undefined &&
        selection.voice !== undefined &&
        querySpeechControlCatalog(
          selection.speechControlCatalog,
          {
            provider: "account-fallback",
            control: "tts.voice",
            model: selection.model,
            voice: selection.voice,
          },
          selection.speechControlCatalogValidatedAt,
        ).status === "supported",
    } satisfies TextToSpeechProvider;
    const failover = createTtsFailoverProvider({ primary, fallback });

    await expect(
      failover.synthesize({
        ...request(),
        speechControlCatalog: catalog,
        speechControlCatalogValidatedAt: validatedAt,
      }),
    ).resolves.toBeDefined();
    expect(fallbackCalls).toBe(1);
  });

  it("uses the call-pinned time when checking an expired fallback catalog during selection", () => {
    const now = Date.now();
    const validatedAt = new Date(now - 2 * 60_000).toISOString() as NonNullable<
      TtsSynthesisRequest["speechControlCatalogValidatedAt"]
    >;
    const catalog = createSpeechControlCatalogSnapshot(
      [
        {
          provider: "account-fallback",
          control: "tts.voice",
          scope: { type: "account", model: "primary-model", voice: "primary-voice" },
          status: "supported",
          mutability: "provider",
          source: "https://provider.example/voices",
          verifiedAt: "2026-10-25",
        },
      ],
      {
        fetchedAt: new Date(now - 3 * 60_000).toISOString(),
        validUntil: new Date(now - 60_000).toISOString(),
      },
    );
    const primary = provider("primary-tts", async () => streamFrom([]));
    const fallback = {
      ...provider("account-fallback", async () => streamFrom([])),
      requiresAccountVoiceCatalog: true,
      supportsTtsSelection: () => true,
    } satisfies TextToSpeechProvider;
    const failover = createTtsFailoverProvider({ primary, fallback });

    expect(
      failover.supportsTtsSelection?.({
        model: "primary-model",
        voice: "primary-voice",
        speechControlCatalog: catalog,
        speechControlCatalogValidatedAt: validatedAt,
      }),
    ).toBe(true);
  });

  it.each(["remove", "replace"] as const)(
    "does not allow a fallback mapper to %s the request catalog",
    async (catalogChange) => {
      const catalog = createSpeechControlCatalogSnapshot(
        [
          {
            provider: "primary-tts",
            control: "tts.voice",
            scope: { type: "account", model: "primary-model", voice: "primary-voice" },
            status: "supported",
            mutability: "provider",
            source: "https://provider.example/voices",
            verifiedAt: "2026-10-25",
          },
        ],
        {
          fetchedAt: new Date(Date.now() - 1_000).toISOString(),
          validUntil: new Date(Date.now() + 60_000).toISOString(),
        },
      );
      const replacementCatalog = createSpeechControlCatalogSnapshot(catalog.facts, {
        fetchedAt: catalog.fetchedAt,
        validUntil: catalog.validUntil,
      });
      const primary = provider("primary-tts", async () => {
        throw TvicThrowableError.from(
          providerError("provider.upstream_failed", "primary is unavailable", {
            provider: "primary-tts",
          }),
        );
      });
      const fallback = provider("fallback-tts", async () => streamFrom([]));
      const failover = createTtsFailoverProvider({
        primary,
        fallback,
        mapFallbackRequest: (value) => {
          if (catalogChange === "replace") {
            return { ...value, speechControlCatalog: replacementCatalog };
          }
          const { speechControlCatalog: _catalog, ...withoutCatalog } = value;
          void _catalog;
          return withoutCatalog;
        },
        fallbackRequestVariants: [{ fallback: { model: "primary-model", voice: "primary-voice" } }],
      });

      await expect(
        failover.synthesize({ ...request(), speechControlCatalog: catalog }),
      ).rejects.toThrow(/mapping may change only provider-specific fields/u);
    },
  );

  it("does not invent language or voice restrictions when the primary omits catalogs", () => {
    const primary: TextToSpeechProvider = {
      ...provider("custom-primary", async () => streamFrom([])),
      capabilities: { ...CAPABILITIES, voices: [] },
    };
    const fallback = provider("custom-fallback", async () => streamFrom([]));
    const failover = createTtsFailoverProvider({ primary, fallback });

    expect(failover.supportsLanguage).toBeUndefined();
    expect(failover.supportsVoice).toBeUndefined();
  });

  it("does not start fallback or cancel the primary twice after caller cancellation", async () => {
    const primaryError = TvicThrowableError.from(
      providerError("provider.upstream_failed", "primary stream failed", {
        provider: "sarvam-tts",
      }),
    );
    let rejectPrimary!: (error: unknown) => void;
    let resolveCancel!: () => void;
    let primaryCancelCalls = 0;
    let fallbackCalls = 0;
    const primary = provider("sarvam-tts", async () => ({
      events: {
        [Symbol.asyncIterator](): AsyncIterator<TtsEvent> {
          return {
            next: () =>
              new Promise<IteratorResult<TtsEvent>>((_resolve, reject) => {
                rejectPrimary = reject;
              }),
            return: async () => ({ done: true, value: undefined as never }),
          };
        },
      },
      async cancel() {
        primaryCancelCalls += 1;
        await new Promise<void>((resolve) => {
          resolveCancel = resolve;
        });
      },
    }));
    const fallback = provider("elevenlabs", async () => {
      fallbackCalls += 1;
      return streamFrom([]);
    });
    const stream = await createTtsFailoverProvider({ primary, fallback }).synthesize(request());
    const collected = collect(stream);
    rejectPrimary(primaryError);
    const cancellation = stream.cancel();
    await Promise.resolve();
    resolveCancel();

    await cancellation;
    await expect(collected).rejects.toMatchObject({ code: "provider.upstream_failed" });
    expect(primaryCancelCalls).toBe(1);
    expect(fallbackCalls).toBe(0);
  });

  it("preserves the primary adapter's configured model and dynamic compatibility policy", () => {
    const primary = {
      ...provider("sarvam-tts", async () => streamFrom([])),
      configuredModel: "bulbul:v4-flash",
      configuredVoice: "kangkana_as_conversational",
      supportsLanguage: (language: string, model?: string) =>
        model === "bulbul:v4-flash" && language === "as-IN",
      supportsVoice: (voice: string, model?: string) =>
        model === "bulbul:v4-flash" && voice === "kangkana_as_conversational",
    } satisfies TextToSpeechProvider;
    const fallback = {
      ...provider("elevenlabs", async () => streamFrom([])),
      capabilities: { ...CAPABILITIES, languages: ["as-IN"] },
      supportsLanguage: (language: string) => language === "as-IN",
    } satisfies TextToSpeechProvider;

    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      mapFallbackRequest: (value) => ({
        ...value,
        model: "primary-model",
        voice: "primary-voice",
      }),
      fallbackRequestVariants: [{ fallback: { model: "primary-model", voice: "primary-voice" } }],
    });

    expect(failover.configuredModel).toBe("bulbul:v4-flash");
    expect(failover.configuredVoice).toBe("kangkana_as_conversational");
    expect(failover.supportsLanguage?.("as-IN", "bulbul:v4-flash")).toBe(true);
    expect(failover.supportsVoice?.("kangkana_as_conversational", "bulbul:v4-flash")).toBe(true);
    expect(failover.supportsLanguage?.("as-IN", "bulbul:v3")).toBe(false);
  });

  it("supports an explicit policy override for provider-specific failures", async () => {
    const primary = provider("sarvam-tts", async () => {
      throw TvicThrowableError.from(
        validationError("provider.invalid_request", "known provider-specific constraint"),
      );
    });
    let fallbackCalls = 0;
    const fallback = provider("elevenlabs", async () => {
      fallbackCalls += 1;
      return streamFrom([]);
    });

    await collect(
      await createTtsFailoverProvider({
        primary,
        fallback,
        shouldFallback: () => true,
      }).synthesize(request()),
    );

    expect(fallbackCalls).toBe(1);
  });

  it("does not accept a mapper that changes runtime identity or format", async () => {
    const primary = provider("sarvam-tts", async () => {
      throw TvicThrowableError.from(
        providerError("provider.upstream_failed", "unavailable", { provider: "sarvam-tts" }),
      );
    });
    const fallback = provider("elevenlabs", async () => streamFrom([]));
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      mapFallbackRequest: (value) => ({ ...value, sessionId: "wrong-session" as never }),
      fallbackRequestVariants: [{ fallback: {} }],
    });

    await expect(failover.synthesize(request())).rejects.toThrow(
      "TTS failover request mapping may change only provider-specific fields",
    );
  });

  it("does not allow a fallback mapper to drop the usage reporter", async () => {
    const primary = provider("sarvam-tts", async () => {
      throw TvicThrowableError.from(
        providerError("provider.upstream_failed", "unavailable", { provider: "sarvam-tts" }),
      );
    });
    let fallbackCalls = 0;
    const fallback = provider("elevenlabs", async () => {
      fallbackCalls += 1;
      return streamFrom([]);
    });
    const usageReporter: TtsUsageReporter = {
      report() {},
      beginOperation() {
        return { report() {}, notReported() {}, finish() {} };
      },
      reportTextCharacters() {},
    };
    const requestValue = { ...request(), usageReporter };
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      mapFallbackRequest: (value) => {
        const { usageReporter: droppedReporter, ...mapped } = value;
        void droppedReporter;
        return mapped;
      },
      fallbackRequestVariants: [{ fallback: {} }],
    });

    await expect(failover.synthesize(requestValue)).rejects.toThrow(
      "TTS failover request mapping may change only provider-specific fields",
    );
    expect(fallbackCalls).toBe(0);
  });

  it("does not allow a fallback mapper to drop typed TTS text parts", async () => {
    const primary = provider("cartesia", async () => {
      throw TvicThrowableError.from(
        providerError("provider.upstream_failed", "unavailable", { provider: "cartesia" }),
      );
    });
    let fallbackCalls = 0;
    const fallback = provider("elevenlabs", async () => {
      fallbackCalls += 1;
      return streamFrom([]);
    });
    const requestValue = {
      ...request(),
      textParts: [
        { type: "text" as const, text: "Your code is " },
        { type: "spell" as const, text: "A7B9" },
      ],
    };
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      mapFallbackRequest: ({ textParts: _droppedParts, ...value }) => value,
      fallbackRequestVariants: [{ fallback: {} }],
    });

    await expect(failover.synthesize(requestValue)).rejects.toThrow(
      "TTS failover request mapping may change only provider-specific fields",
    );
    expect(fallbackCalls).toBe(0);
  });

  it("rejects an in-place format mutation from the mapper without mutating the caller request", async () => {
    const primary = provider("sarvam-tts", async () => {
      throw TvicThrowableError.from(
        providerError("provider.upstream_failed", "unavailable", { provider: "sarvam-tts" }),
      );
    });
    let fallbackCalls = 0;
    const fallback = provider("elevenlabs", async () => {
      fallbackCalls += 1;
      return streamFrom([]);
    });
    const format = { ...PCM16_16K_MONO };
    const requestValue = { ...request(), format };
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      mapFallbackRequest: (value) => {
        (value.format as unknown as { sampleRateHz: number }).sampleRateHz = 8_000;
        return value;
      },
      fallbackRequestVariants: [{ fallback: {} }],
    });

    await expect(failover.synthesize(requestValue)).rejects.toThrow(
      "TTS failover request mapping may change only provider-specific fields",
    );
    expect(requestValue.format).toEqual(PCM16_16K_MONO);
    expect(fallbackCalls).toBe(0);
  });

  it("does not advertise or invoke a fallback with undeclared output formats", async () => {
    const primaryError = TvicThrowableError.from(
      providerError("provider.upstream_failed", "primary unavailable", {
        provider: "primary-tts",
      }),
    );
    const primary = provider("primary-tts", async () => {
      throw primaryError;
    });
    let fallbackCalls = 0;
    const fallback = {
      ...provider("fallback-tts", async () => {
        fallbackCalls += 1;
        return streamFrom([]);
      }),
      capabilities: { ...CAPABILITIES, audio: {} },
    } satisfies TextToSpeechProvider;
    const failover = createTtsFailoverProvider({ primary, fallback });

    expect(failover.capabilities.audio?.output).toBeUndefined();
    expect(
      evaluateProviderCompatibility(failover, {
        kind: "tts",
        outputFormat: PCM16_16K_MONO,
      }),
    ).toMatchObject({ compatible: false, issues: [{ code: "audio.output_unsupported" }] });
    await expect(failover.synthesize(request())).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerInvalidRequest,
    });
    expect(fallbackCalls).toBe(0);
  });

  it("does not accept a mapper that changes the utterance sent to the fallback", async () => {
    const primary = provider("sarvam-tts", async () => {
      throw TvicThrowableError.from(
        providerError("provider.upstream_failed", "unavailable", { provider: "sarvam-tts" }),
      );
    });
    let fallbackCalls = 0;
    const fallback = provider("elevenlabs", async () => {
      fallbackCalls += 1;
      return streamFrom([]);
    });
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      mapFallbackRequest: (value) => ({ ...value, text: "a different utterance" }),
      fallbackRequestVariants: [{ fallback: {} }],
    });

    await expect(failover.synthesize(request())).rejects.toThrow(
      "TTS failover request mapping may change only provider-specific fields",
    );
    expect(fallbackCalls).toBe(0);
  });

  it("does not accept a mapper that changes generic speed, timestamp, or metadata options", async () => {
    const primary = provider("sarvam-tts", async () => {
      throw TvicThrowableError.from(
        providerError("provider.upstream_failed", "unavailable", { provider: "sarvam-tts" }),
      );
    });
    let fallbackCalls = 0;
    const fallback = provider("elevenlabs", async () => {
      fallbackCalls += 1;
      return streamFrom([]);
    });
    const original = {
      ...request(),
      speed: 0.9,
      timestamps: true,
      metadata: { traceId: "trace-1" },
    };
    const mappings = [
      {
        mapFallbackRequest: (value: TtsSynthesisRequest) => ({ ...value, speed: 1.2 }),
        expected: "TTS failover mapping must produce one declared fallback request variant",
      },
      {
        mapFallbackRequest: (value: TtsSynthesisRequest) => ({ ...value, timestamps: false }),
        expected: "TTS failover request mapping may change only provider-specific fields",
      },
      {
        mapFallbackRequest: (value: TtsSynthesisRequest) => ({
          ...value,
          metadata: { traceId: "trace-2" },
        }),
        expected: "TTS failover request mapping may change only provider-specific fields",
      },
    ];

    for (const { mapFallbackRequest, expected } of mappings) {
      const failover = createTtsFailoverProvider({
        primary,
        fallback,
        mapFallbackRequest,
        fallbackRequestVariants: [{ fallback: {} }],
      });
      await expect(failover.synthesize(original)).rejects.toThrow(expected);
    }

    expect(fallbackCalls).toBe(0);
  });

  it("rejects uncloneable metadata before a mapper can mutate caller-owned objects", async () => {
    const primary = provider("primary-tts", async () => {
      throw TvicThrowableError.from(
        providerError("provider.upstream_failed", "primary unavailable", {
          provider: "primary-tts",
          retriable: true,
        }),
      );
    });
    let fallbackCalls = 0;
    let mapperCalls = 0;
    const fallback = provider("fallback-tts", async () => {
      fallbackCalls += 1;
      return streamFrom([]);
    });
    const date = new Date(0);
    const requestValue = {
      ...request(),
      metadata: { callback: () => undefined, nested: { date } },
    };
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      mapFallbackRequest: (value) => {
        mapperCalls += 1;
        (value.metadata?.nested as { date: Date }).date.setTime(1);
        return value;
      },
    });

    await expect(failover.synthesize(requestValue)).rejects.toThrow(/structured-cloneable/u);
    expect(date.getTime()).toBe(0);
    expect(mapperCalls).toBe(0);
    expect(fallbackCalls).toBe(0);
  });
});
