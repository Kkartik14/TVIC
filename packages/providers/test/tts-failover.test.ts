import { EventEmitter } from "node:events";

import WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";

import {
  createMediaEvent,
  PROVIDER_CAPABILITY_FEATURES,
  PROVIDER_NAMES,
  createProviderCapabilitySnapshot,
  nowTimestamp,
  PCM16_16K_MONO,
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
  createCartesiaTtsProvider,
  createElevenLabsTtsHttpStreamProvider,
  createElevenLabsTtsProvider,
  createElevenLabsTtsRestProvider,
  createElevenLabsMultiContextProvider,
  createSarvamTtsProvider,
  createSarvamTtsHttpStreamProvider,
  createSarvamTtsRestProvider,
  SARVAM_TTS_V4_FLASH_MODEL,
  SARVAM_TTS_V4_FLASH_VOICES,
  createTtsFailoverProvider,
  supportsLanguage,
} from "../src/index.js";
import { elevenLabsCapabilitySnapshot } from "./elevenlabs-capability-fixtures.js";

const CAPABILITIES = {
  streaming: { input: false, output: true, native: true },
  cancellation: { request: true, output: true, buffer: false, truncation: false },
  transports: ["http"],
  audio: { output: [PCM16_16K_MONO] },
  models: ["primary-model"],
  ttsSpeedRanges: [{ model: "primary-model", min: 0.6, max: 1.5 }],
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

function cartesiaCapabilitySnapshot(voice: string, model = "sonic-3.6") {
  const now = Date.now();
  return createProviderCapabilitySnapshot({
    provider: PROVIDER_NAMES.cartesia,
    source: "https://provider.example/capabilities",
    fetchedAt: new Date(now - 1_000).toISOString(),
    validUntil: new Date(now + 60_000).toISOString(),
    facts: [
      {
        feature: PROVIDER_CAPABILITY_FEATURES.ttsVoiceAvailable,
        scope: "voice",
        model,
        voice,
        status: "supported",
      },
    ],
  });
}

function elevenLabsRequest(model: string, voice: string): TtsSynthesisRequest {
  return {
    ...requestWithoutModelOrVoice(),
    model,
    voice,
    providerCapabilitySnapshots: [elevenLabsCapabilitySnapshot({ model, voice })],
  };
}

function cartesiaRequest(voice: string): TtsSynthesisRequest {
  return {
    ...requestWithoutModelOrVoice(),
    providerCapabilitySnapshots: [cartesiaCapabilitySnapshot(voice)],
  };
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
  it("declares speed ranges on every shipped provider route", () => {
    const providers = [
      createCartesiaTtsProvider({ apiKey: "test", voiceId: "cartesia-voice" }),
      createElevenLabsTtsProvider({ apiKey: "test", voiceId: "elevenlabs-voice" }),
      createElevenLabsTtsRestProvider({ apiKey: "test", voiceId: "elevenlabs-voice" }),
      createElevenLabsTtsHttpStreamProvider({ apiKey: "test", voiceId: "elevenlabs-voice" }),
      createElevenLabsMultiContextProvider({
        apiKey: "test",
        voiceId: "elevenlabs-voice",
        protocol: "tts",
      }),
      createSarvamTtsProvider({ apiKey: "test" }),
      createSarvamTtsRestProvider({ apiKey: "test" }),
      createSarvamTtsHttpStreamProvider({ apiKey: "test" }),
    ];

    const requiredSelectionFor = (providerValue: object, model: string) => {
      const hooks = providerValue as Partial<TextToSpeechProvider>;
      return {
        ...(hooks.requiresTtsLanguageForModel?.(model) === true ? { language: "en-IN" } : {}),
        ...(hooks.requiresTtsVoiceForModel?.(model) === true
          ? { voice: SARVAM_TTS_V4_FLASH_VOICES[0] }
          : {}),
      };
    };

    for (const providerValue of providers) {
      const ranges = providerValue.capabilities.ttsSpeedRanges;
      expect(ranges?.length).toBeGreaterThan(0);
      for (const range of ranges ?? []) {
        expect(
          evaluateProviderCompatibility(providerValue, {
            kind: "tts",
            model: range.model,
            ...requiredSelectionFor(providerValue, range.model),
            ttsSpeed: range.min,
          }).compatible,
        ).toBe(true);
        expect(
          evaluateProviderCompatibility(providerValue, {
            kind: "tts",
            model: range.model,
            ...requiredSelectionFor(providerValue, range.model),
            ttsSpeed: range.max,
          }).compatible,
        ).toBe(true);
      }
    }
    expect(
      providers[1]!.capabilities.ttsSpeedRanges?.some((range) => range.model === "eleven_v3"),
    ).toBe(false);
    expect(
      providers[1]!.capabilities.ttsSpeedRanges?.some(
        (range) => range.model === "eleven_v3_conversational",
      ),
    ).toBe(false);
  });

  it("rejects a speed unsupported by the fallback before primary synthesis", async () => {
    const primarySynthesize = vi.fn(async () => streamFrom([]));
    const fallbackSynthesize = vi.fn(async () => streamFrom([]));
    const primary = provider("primary-tts", primarySynthesize);
    const fallback = {
      ...provider("fallback-tts", fallbackSynthesize),
      capabilities: {
        ...CAPABILITIES,
        ttsSpeedRanges: [{ model: "primary-model", min: 0.7, max: 1.2 }],
      },
    };
    expect(
      evaluateProviderCompatibility(fallback, {
        kind: "tts",
        model: "primary-model",
        ttsSpeed: 1.3,
      }),
    ).toMatchObject({ compatible: false, issues: [{ code: "tts_speed.unsupported" }] });
    const failover = createTtsFailoverProvider({ primary, fallback });
    expect(failover.capabilities.ttsSpeedRanges).toEqual([
      { model: "primary-model", min: 0.7, max: 1.2 },
    ]);

    await expect(failover.synthesize({ ...request(), speed: 1.3 })).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerInvalidRequest,
      metadata: {
        issues: [
          {
            code: "tts_speed.unsupported",
            requirement: "ttsSpeed",
          },
        ],
      },
    });
    expect(primarySynthesize).not.toHaveBeenCalled();
    expect(fallbackSynthesize).not.toHaveBeenCalled();
  });

  it("preserves both providers' unique capability requirements", () => {
    const normalizationRequirement = {
      provider: "elevenlabs",
      feature: "tts.normalization.forced",
      scope: "account",
    } as const;
    const primary = {
      ...provider("primary-tts", async () => streamFrom([])),
      requiredCapabilityQueries: [normalizationRequirement],
    };
    const fallback = {
      ...provider("fallback-tts", async () => streamFrom([])),
      requiredCapabilityQueries: [normalizationRequirement],
    };

    expect(createTtsFailoverProvider({ primary, fallback }).requiredCapabilityQueries).toEqual([
      normalizationRequirement,
    ]);
  });

  it("preserves voice-specific capability requirements from both children", () => {
    const voiceRequirement = {
      provider: "cartesia",
      feature: "tts.voice.isPro",
      expectedBooleanValue: false,
    } as const;
    const primary = {
      ...provider("primary-tts", async () => streamFrom([])),
      requiredTtsVoiceCapabilities: [voiceRequirement],
    };
    const fallback = {
      ...provider("fallback-tts", async () => streamFrom([])),
      requiredTtsVoiceCapabilities: [{ ...voiceRequirement, provider: "elevenlabs" }],
    };

    expect(createTtsFailoverProvider({ primary, fallback }).requiredTtsVoiceCapabilities).toEqual([
      { ...voiceRequirement, voiceSource: "requested" },
      { ...voiceRequirement, provider: "elevenlabs", voiceSource: "mapped" },
    ]);
  });

  it("binds unqualified voice requirements to the child providers", () => {
    const requirement = {
      feature: "tts.voice.isPro",
      expectedBooleanValue: false,
    } as const;
    const primary = {
      ...provider("primary-tts", async () => streamFrom([])),
      requiredTtsVoiceCapabilities: [requirement],
    };
    const fallback = {
      ...provider("fallback-tts", async () => streamFrom([])),
      requiredTtsVoiceCapabilities: [requirement],
    };

    expect(createTtsFailoverProvider({ primary, fallback }).requiredTtsVoiceCapabilities).toEqual([
      { ...requirement, provider: "primary-tts", voiceSource: "requested" },
      { ...requirement, provider: "fallback-tts", voiceSource: "mapped" },
    ]);
  });

  it("retains requested and mapped voice requirements when both attempts use one provider", () => {
    const voiceRequirement = {
      provider: "cartesia",
      feature: "tts.voice.isPro",
      expectedBooleanValue: false,
    } as const;
    const primary = {
      ...provider("cartesia", async () => streamFrom([])),
      requiredTtsVoiceCapabilities: [voiceRequirement],
    };
    const fallback = {
      ...provider("cartesia", async () => streamFrom([])),
      requiredTtsVoiceCapabilities: [voiceRequirement],
    };

    const failover = createTtsFailoverProvider({
      primary,
      fallback: {
        ...fallback,
        capabilities: {
          ...fallback.capabilities,
          models: ["fallback-model"],
          voices: ["fallback-voice"],
        },
      },
      fallbackRequestVariants: [
        {
          when: { model: "primary-model", voice: "primary-voice" },
          fallback: { model: "fallback-model", voice: "fallback-voice" },
        },
      ],
      mapFallbackRequest: (value) => ({
        ...value,
        model: "fallback-model",
        voice: "fallback-voice",
      }),
    });

    expect(failover.requiredTtsVoiceCapabilities).toEqual([
      { ...voiceRequirement, voiceSource: "requested" },
      { ...voiceRequirement, voiceSource: "mapped" },
    ]);
  });

  it("supports a fresh-object mapper with an account-backed fallback", async () => {
    const fallbackRequests: TtsSynthesisRequest[] = [];
    const primaryError = TvicThrowableError.from(
      providerError("provider.upstream_failed", "primary unavailable", {
        provider: "primary-tts",
      }),
    );
    const primary = provider("primary-tts", async () => {
      throw primaryError;
    });
    const fallback = {
      ...provider("account-fallback", async (value) => {
        fallbackRequests.push(value);
        return streamFrom([]);
      }),
      capabilities: {
        ...CAPABILITIES,
        models: ["fallback-model"],
        voiceSelection: "account_snapshot" as const,
      },
    };
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      mapFallbackRequest: (value) => ({
        sessionId: value.sessionId,
        turnId: value.turnId,
        format: value.format,
        text: value.text,
        stream: value.stream,
        model: "fallback-model",
        voice: "fallback-voice",
      }),
    });
    expect(failover.providerCapabilitySnapshotProviders).toContain("account-fallback");

    await collect(await failover.synthesize(request()));

    expect(fallbackRequests[0]).toMatchObject({
      model: "fallback-model",
      voice: "fallback-voice",
    });
  });

  it("forwards primary dialogue voices required by snapshot preflight", () => {
    const primary = {
      ...provider("elevenlabs", async () => streamFrom([])),
      providerCapabilitySnapshotProviders: ["elevenlabs"],
      providerCapabilitySnapshotVoices: [
        { provider: "elevenlabs", model: "eleven_v3", voice: "voice-a" },
        { provider: "elevenlabs", model: "eleven_v3", voice: "voice-b" },
      ],
    };
    const fallback = provider("fallback-tts", async () => streamFrom([]));

    const failover = createTtsFailoverProvider({ primary, fallback });

    expect(failover.providerCapabilitySnapshotVoices).toEqual([
      { provider: "elevenlabs", model: "eleven_v3", voice: "voice-a", side: "primary" },
      { provider: "elevenlabs", model: "eleven_v3", voice: "voice-b", side: "primary" },
    ]);
  });

  it("keeps nested snapshot voice selections paired with their declared model", () => {
    const accountProvider = (name: string, model: string): TextToSpeechProvider => ({
      ...provider(name, async () => streamFrom([])),
      capabilities: {
        ...CAPABILITIES,
        models: [model],
        voices: ["shared-voice"],
        voiceSelection: "account_snapshot",
        voiceSnapshotProviders: [name],
      },
      configuredModel: model,
      configuredVoice: "shared-voice",
      providerCapabilitySnapshotVoices: [{ provider: name, model, voice: "shared-voice" }],
    });
    const inner = createTtsFailoverProvider({
      primary: accountProvider("inner-primary-tts", "inner-primary-model"),
      fallback: accountProvider("inner-fallback-tts", "inner-fallback-model"),
      fallbackRequestVariants: [
        {
          when: { model: "inner-primary-model", voice: "shared-voice" },
          fallback: { model: "inner-fallback-model", voice: "shared-voice" },
        },
      ],
    });
    const outerPrimary = {
      ...provider("outer-primary-tts", async () => streamFrom([])),
      capabilities: {
        ...CAPABILITIES,
        models: ["outer-primary-model"],
        voices: ["outer-voice"],
      },
      configuredModel: "outer-primary-model",
      configuredVoice: "outer-voice",
    } satisfies TextToSpeechProvider;

    const outer = createTtsFailoverProvider({
      primary: outerPrimary,
      fallback: inner,
      fallbackRequestVariants: [
        {
          when: { model: "outer-primary-model", voice: "outer-voice" },
          fallback: { model: "inner-primary-model", voice: "shared-voice" },
        },
      ],
    });

    expect(outer.providerCapabilitySnapshotVoices).toEqual(
      expect.arrayContaining([
        {
          provider: "inner-primary-tts",
          model: "inner-primary-model",
          voice: "shared-voice",
          modelSource: "mapped",
          side: "fallback",
        },
        {
          provider: "inner-fallback-tts",
          model: "inner-fallback-model",
          voice: "shared-voice",
          modelSource: "mapped",
          side: "fallback",
        },
      ]),
    );
    expect(outer.providerCapabilitySnapshotVoices).not.toContainEqual(
      expect.objectContaining({
        provider: "inner-fallback-tts",
        model: "inner-primary-model",
        voice: "shared-voice",
      }),
    );
  });

  it("requires mapping coverage for registered primary dialogue voices", () => {
    const primary = createElevenLabsTtsProvider({
      apiKey: "test",
      modelId: "eleven_v3",
      voiceId: "voice-a",
      dialogueVoices: ["voice-a", "voice-b"],
    });
    const fallback = createElevenLabsTtsRestProvider({
      apiKey: "test",
      modelId: "eleven_v3",
      voiceId: "voice-c",
      dialogueVoices: ["voice-c"],
    });

    expect(() =>
      createTtsFailoverProvider({
        primary,
        fallback,
        fallbackRequestVariants: [
          {
            when: { model: "eleven_v3", voice: "voice-a" },
            fallback: { model: "eleven_v3", voice: "voice-c" },
          },
        ],
      }),
    ).toThrow(/must include primary dialogue voice voice-b/u);
  });

  it("requires mapped voices to be registered by a dialogue fallback", () => {
    const primary = createElevenLabsTtsProvider({
      apiKey: "test",
      modelId: "eleven_v3",
      voiceId: "voice-a",
    });
    const fallback = createElevenLabsTtsRestProvider({
      apiKey: "test",
      modelId: "eleven_v3",
      voiceId: "voice-c",
      dialogueVoices: ["voice-c"],
    });

    expect(() =>
      createTtsFailoverProvider({
        primary,
        fallback,
        fallbackRequestVariants: [
          {
            when: { model: "eleven_v3", voice: "voice-a" },
            fallback: { model: "eleven_v3", voice: "voice-b" },
          },
        ],
      }),
    ).toThrow(/voice voice-b is not registered in fallback/u);
  });

  it("rejects a fallback dialogue model that conflicts with its registered voice count", () => {
    const primary = {
      ...provider("primary-tts", async () => streamFrom([])),
      configuredModel: "primary-model",
      configuredVoice: "primary-voice",
    };
    const fallback = createElevenLabsTtsRestProvider({
      apiKey: "test",
      modelId: "eleven_v3",
      voiceId: "voice-a",
      dialogueVoices: ["voice-a", "voice-b"],
      fetchImpl: vi.fn(),
    });

    expect(() =>
      createTtsFailoverProvider({
        primary,
        fallback,
        fallbackRequestVariants: [
          {
            when: { model: "primary-model", voice: "primary-voice" },
            fallback: { model: "eleven_v3_conversational", voice: "voice-a" },
          },
        ],
      }),
    ).toThrow(/cannot use its configured options with mapped model eleven_v3_conversational/u);
  });

  it("checks nested primary dialogue voices against the outer mapping table", () => {
    const dialoguePrimary = createElevenLabsTtsProvider({
      apiKey: "test",
      modelId: "eleven_v3",
      voiceId: "voice-a",
      dialogueVoices: ["voice-a", "voice-b"],
    });
    const innerFallback: TextToSpeechProvider = {
      ...provider("inner-fallback", async () => streamFrom([])),
      configuredModel: "eleven_v3",
      configuredVoice: "voice-a",
      capabilities: { ...CAPABILITIES, models: ["eleven_v3"], voices: ["voice-a", "voice-b"] },
    };
    const inner = createTtsFailoverProvider({
      primary: dialoguePrimary,
      fallback: innerFallback,
      fallbackRequestVariants: [
        {
          when: { model: "eleven_v3", voice: "voice-a" },
          fallback: { model: "eleven_v3", voice: "voice-a" },
        },
        {
          when: { model: "eleven_v3", voice: "voice-b" },
          fallback: { model: "eleven_v3", voice: "voice-b" },
        },
      ],
    });
    const outerFallback: TextToSpeechProvider = {
      ...provider("outer-fallback", async () => streamFrom([])),
      configuredModel: "eleven_v3",
      configuredVoice: "outer-a",
      capabilities: { ...CAPABILITIES, models: ["eleven_v3"], voices: ["outer-a"] },
    };

    expect(() =>
      createTtsFailoverProvider({
        primary: inner,
        fallback: outerFallback,
        fallbackRequestVariants: [
          {
            when: { model: "eleven_v3", voice: "voice-a" },
            fallback: { model: "eleven_v3", voice: "outer-a" },
          },
        ],
      }),
    ).toThrow(/must include primary dialogue voice voice-b/u);
  });

  it("propagates a nested snapshot mapping requirement", () => {
    const primary = provider("primary-tts", async () => streamFrom([]));
    const nested = {
      ...provider("nested-failover", async () => streamFrom([])),
      requiresDeclaredTtsVoiceMappingForCapabilitySnapshots: true,
    } satisfies TextToSpeechProvider;

    const outer = createTtsFailoverProvider({ primary, fallback: nested });

    expect(outer.requiresDeclaredTtsVoiceMappingForCapabilitySnapshots).toBe(true);
  });

  it("uses the configured model when checking a mapped voice without an explicit model", () => {
    const primary = {
      ...provider("primary-tts", async () => streamFrom([])),
      configuredModel: "primary-model",
      configuredVoice: "primary-voice",
      supportsVoice: (voice: string, model?: string) =>
        voice === "primary-voice" && model === "primary-model",
    } satisfies TextToSpeechProvider;
    const fallback = {
      ...provider("fallback-tts", async () => streamFrom([])),
      capabilities: { ...CAPABILITIES, models: ["fallback-model"], voices: ["fallback-voice"] },
      configuredModel: "fallback-model",
      configuredVoice: "fallback-voice",
      supportsVoice: (voice: string, model?: string) =>
        voice === "fallback-voice" && model === "fallback-model",
    } satisfies TextToSpeechProvider;

    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      fallbackRequestVariants: [
        {
          when: { model: "primary-model", voice: "primary-voice" },
          fallback: { model: "fallback-model", voice: "fallback-voice" },
        },
      ],
    });

    expect(failover.supportsVoice?.("primary-voice")).toBe(true);
  });

  it("requires a matching variant when a mapper and fallback variants are combined", async () => {
    const primaryError = TvicThrowableError.from(
      providerError("provider.upstream_failed", "primary unavailable", {
        provider: "primary-tts",
      }),
    );
    const primarySynthesize = vi.fn(async () => {
      throw primaryError;
    });
    const fallbackSynthesize = vi.fn(async () => streamFrom([]));
    const mapper = vi.fn((value: TtsSynthesisRequest) => ({ ...value, voice: "mapped-voice" }));
    const failover = createTtsFailoverProvider({
      primary: {
        ...provider("primary-tts", primarySynthesize),
        configuredModel: "primary-model",
        configuredVoice: "primary-voice",
      },
      fallback: {
        ...provider("fallback-tts", fallbackSynthesize),
        capabilities: { ...CAPABILITIES, voices: ["mapped-voice"] },
        configuredModel: "primary-model",
        configuredVoice: "mapped-voice",
      },
      fallbackRequestVariants: [
        {
          when: { model: "primary-model", voice: "primary-voice" },
          fallback: { voice: "mapped-voice" },
        },
      ],
      mapFallbackRequest: mapper,
    });

    expect(failover.supportsVoice?.("unmapped-voice", "primary-model")).toBe(false);
    expect(
      failover.supportsTtsSelection?.({ model: "primary-model", voice: "unmapped-voice" }),
    ).toBe(false);
    await expect(
      failover.synthesize({ ...request(), voice: "unmapped-voice" }),
    ).rejects.toMatchObject({
      code: "provider.upstream_failed",
      metadata: {
        fallbackValidationFailure: { category: "validation", provider: "fallback-tts" },
      },
    });
    expect(fallbackSynthesize).not.toHaveBeenCalled();
  });

  it("reports invalid mapped selections on the primary failure", async () => {
    const primaryError = TvicThrowableError.from(
      providerError("provider.upstream_failed", "primary unavailable", {
        provider: "primary-tts",
      }),
    );
    let fallbackCalls = 0;
    const failover = createTtsFailoverProvider({
      primary: provider("primary-tts", async () => {
        throw primaryError;
      }),
      fallback: {
        ...provider("fallback-tts", async () => {
          fallbackCalls += 1;
          return streamFrom([]);
        }),
        capabilities: { ...CAPABILITIES, models: ["fallback-model"], voices: ["fallback-voice"] },
      },
      mapFallbackRequest: (value) => ({
        ...value,
        model: "fallback-model",
        voice: "undeclared-voice",
      }),
    });

    await expect(failover.synthesize(request())).rejects.toMatchObject({
      code: "provider.upstream_failed",
      provider: "primary-tts",
      metadata: {
        fallbackValidationFailure: {
          code: TVIC_ERROR_CODES.providerVoiceUnsupported,
          category: "validation",
          provider: "fallback-tts",
        },
      },
    });
    expect(fallbackCalls).toBe(0);
  });

  it("preserves a provider error deliberately rethrown by the request mapper", async () => {
    const primaryError = providerError("provider.upstream_failed", "primary unavailable", {
      provider: "primary-tts",
      retriable: true,
    });
    const failover = createTtsFailoverProvider({
      primary: provider("primary-tts", async () => {
        throw primaryError;
      }),
      fallback: provider("fallback-tts", async () => streamFrom([])),
      mapFallbackRequest: (_value, error) => {
        throw error;
      },
    });

    await expect(failover.synthesize(request())).rejects.toMatchObject({
      code: "provider.upstream_failed",
      category: "provider",
      provider: "primary-tts",
      retriable: true,
    });
  });

  it("summarizes a mapped validation error on the primary failure", async () => {
    const primaryError = providerError("provider.upstream_failed", "primary unavailable", {
      provider: "primary-tts",
    });
    const existingCause = new Error("mapper context");
    const failover = createTtsFailoverProvider({
      primary: provider("primary-tts", async () => {
        throw primaryError;
      }),
      fallback: provider("fallback-tts", async () => streamFrom([])),
      mapFallbackRequest: () => {
        throw validationError("provider.invalid_request", "mapper rejected the request", {
          cause: existingCause,
        });
      },
    });

    const failure = await failover.synthesize(request()).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "provider.upstream_failed",
      provider: "primary-tts",
      metadata: {
        fallbackValidationFailure: {
          code: "provider.invalid_request",
          category: "validation",
          message: "mapper rejected the request",
        },
      },
    });
    expect((failure as { cause?: unknown }).cause).not.toBe(existingCause);
  });

  it("records a mapper failure summary on the primary failure", async () => {
    const primaryError = providerError("provider.upstream_failed", "primary unavailable", {
      provider: "primary-tts",
    });
    const mapperError = new Error("mapper failed");
    const failover = createTtsFailoverProvider({
      primary: provider("primary-tts", async () => {
        throw primaryError;
      }),
      fallback: provider("fallback-tts", async () => streamFrom([])),
      mapFallbackRequest: () => {
        throw mapperError;
      },
    });

    await expect(failover.synthesize(request())).rejects.toMatchObject({
      code: "provider.upstream_failed",
      provider: "primary-tts",
      metadata: {
        fallbackValidationFailure: { message: "mapper failed" },
      },
    });
  });

  it("propagates fallback provider errors after dispatch unchanged", async () => {
    const primaryError = providerError("provider.upstream_failed", "primary unavailable", {
      provider: "primary-tts",
    });
    const fallbackCause = new Error("fallback socket reset");
    const fallbackError = providerError("provider.upstream_failed", "fallback unavailable", {
      provider: "fallback-tts",
      retriable: true,
      cause: fallbackCause,
    });
    const failover = createTtsFailoverProvider({
      primary: provider("primary-tts", async () => {
        throw primaryError;
      }),
      fallback: provider("fallback-tts", async () => {
        throw fallbackError;
      }),
    });

    await expect(failover.synthesize(request())).rejects.toMatchObject({
      code: "provider.upstream_failed",
      category: "provider",
      provider: "fallback-tts",
      retriable: true,
      cause: fallbackCause,
    });
  });

  it("reports cancellation when the mapper throws after the caller aborts", async () => {
    const controller = new AbortController();
    const failover = createTtsFailoverProvider({
      primary: provider("primary-tts", async () => {
        throw providerError("provider.upstream_failed", "primary unavailable", {
          provider: "primary-tts",
        });
      }),
      fallback: provider("fallback-tts", async () => streamFrom([])),
      mapFallbackRequest: () => {
        controller.abort();
        throw new Error("mapper failed after cancellation");
      },
    });

    await expect(
      failover.synthesize({ ...request(), signal: controller.signal }),
    ).rejects.toMatchObject({
      code: "provider.connection_cancelled",
      category: "cancelled",
    });
  });

  it("declares and enforces the exact account-backed fallback selection", async () => {
    const fallbackRequests: TtsSynthesisRequest[] = [];
    const fallback = {
      ...provider("account-fallback", async (value) => {
        fallbackRequests.push(value);
        return streamFrom([]);
      }),
      capabilities: {
        ...CAPABILITIES,
        models: ["fallback-model"],
        voiceSelection: "account_snapshot" as const,
      },
    };
    const failover = createTtsFailoverProvider({
      primary: provider("primary-tts", async () => {
        throw TvicThrowableError.from(
          providerError("provider.upstream_failed", "primary unavailable", {
            provider: "primary-tts",
          }),
        );
      }),
      fallback,
      fallbackRequestVariants: [
        {
          when: { model: "primary-model", voice: "primary-voice" },
          fallback: { model: "fallback-model", voice: "fallback-voice" },
        },
      ],
      mapFallbackRequest: (value) => ({
        ...value,
        model: "fallback-model",
        voice: "fallback-voice",
      }),
    });

    expect(failover.capabilities.ttsVoiceMappings).toEqual([
      {
        requestedModel: "primary-model",
        requestedVoice: "primary-voice",
        requestedProvider: "primary-tts",
        model: "fallback-model",
        voice: "fallback-voice",
        provider: "account-fallback",
      },
    ]);
    await collect(await failover.synthesize(request()));
    expect(fallbackRequests[0]).toMatchObject({
      model: "fallback-model",
      voice: "fallback-voice",
    });
  });

  it("resolves omitted fallback mapping selectors from the primary defaults", async () => {
    const fallbackRequests: TtsSynthesisRequest[] = [];
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
    };
    const fallback = {
      ...provider("fallback-tts", async (value) => {
        fallbackRequests.push(value);
        return streamFrom([]);
      }),
      capabilities: { ...CAPABILITIES, voices: ["fallback-voice"] },
      configuredModel: "primary-model",
      configuredVoice: "fallback-voice",
    };
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      fallbackRequestVariants: [{ fallback: { voice: "fallback-voice" } }],
    });

    await collect(await failover.synthesize(request()));

    expect(fallbackRequests[0]).toMatchObject({
      model: "primary-model",
      voice: "fallback-voice",
    });
  });

  it("keeps request model usage attribution when a mapper changes only voice", () => {
    const primary = {
      ...provider("primary-tts", async () => streamFrom([])),
      configuredModel: "primary-model",
      configuredVoice: "primary-voice",
    };
    const fallback = {
      ...provider("fallback-tts", async () => streamFrom([])),
      capabilities: { ...CAPABILITIES, voices: ["fallback-voice"] },
      configuredModel: "primary-model",
      configuredVoice: "fallback-voice",
    };

    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      fallbackRequestVariants: [{ fallback: { voice: "fallback-voice" } }],
      mapFallbackRequest: (value) => ({ ...value, voice: "fallback-voice" }),
    });

    expect(failover.usageAccounting).toEqual({
      reportsTextCharacters: true,
      usesRequestModelForUsage: true,
    });
  });

  it("does not infer request model usage when variants without a mapper leave the model to the fallback", () => {
    const primary = {
      ...provider("primary-tts", async () => streamFrom([])),
      configuredModel: "primary-model",
      configuredVoice: "primary-voice",
    };
    const fallback = {
      ...provider("fallback-tts", async () => streamFrom([])),
      capabilities: { ...CAPABILITIES, voices: ["fallback-voice"] },
      configuredModel: "primary-model",
      configuredVoice: "fallback-voice",
    };

    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      fallbackRequestVariants: [{ fallback: { voice: "fallback-voice" } }],
    });

    expect(failover.usageAccounting).toEqual({ reportsTextCharacters: true });
  });

  it("does not infer request model usage when a fallback mapping changes model", () => {
    const primary = {
      ...provider("primary-tts", async () => streamFrom([])),
      configuredModel: "primary-model",
      configuredVoice: "primary-voice",
    };
    const fallback = {
      ...provider("fallback-tts", async () => streamFrom([])),
      capabilities: { ...CAPABILITIES, models: ["fallback-model"], voices: ["fallback-voice"] },
      configuredModel: "fallback-model",
      configuredVoice: "fallback-voice",
    };

    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      fallbackRequestVariants: [
        {
          when: { model: "primary-model" },
          fallback: { model: "fallback-model", voice: "fallback-voice" },
        },
      ],
    });

    expect(failover.usageAccounting).toEqual({ reportsTextCharacters: true });
  });

  it("rejects an oversized fallback variant list before reading its entries", () => {
    const variants = new Proxy(
      Array.from({ length: 17 }, () => ({ fallback: { voice: "fallback-voice" } })),
      {
        get(target, property, receiver) {
          if (property === "0") throw new Error("variant entry read before limit check");
          return Reflect.get(target, property, receiver);
        },
      },
    );

    expect(() =>
      createTtsFailoverProvider({
        primary: provider("primary-tts", async () => streamFrom([])),
        fallback: provider("fallback-tts", async () => streamFrom([])),
        fallbackRequestVariants: variants,
      }),
    ).toThrow(/one to 16 entries/);
  });

  it("rejects a direct synthesis voice without a declared fallback mapping before primary synthesis", async () => {
    const primarySynthesize = vi.fn(async () => streamFrom([]));
    const fallbackSynthesize = vi.fn(async () => streamFrom([]));
    const primary = {
      ...provider("primary-tts", primarySynthesize),
      configuredModel: "primary-model",
      configuredVoice: "primary-voice",
    };
    const fallback = {
      ...provider("fallback-tts", fallbackSynthesize),
      capabilities: { ...CAPABILITIES, voices: ["fallback-voice"] },
      configuredModel: "primary-model",
      configuredVoice: "fallback-voice",
    };
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      fallbackRequestVariants: [
        {
          when: { model: "primary-model", voice: "primary-voice" },
          fallback: { voice: "fallback-voice" },
        },
      ],
    });

    await expect(
      failover.synthesize({ ...request(), voice: "unmapped-voice" }),
    ).rejects.toMatchObject({ code: "provider.invalid_request", category: "validation" });
    expect(primarySynthesize).not.toHaveBeenCalled();
    expect(fallbackSynthesize).not.toHaveBeenCalled();
  });

  it("maps the fallback model and voice from variants when no mapper is supplied", async () => {
    const fallbackRequests: TtsSynthesisRequest[] = [];
    const primary = provider("primary-tts", async () => {
      throw TvicThrowableError.from(
        providerError("provider.upstream_failed", "primary unavailable", {
          provider: "primary-tts",
        }),
      );
    });
    const fallback = {
      ...provider("fallback-tts", async (value) => {
        fallbackRequests.push(value);
        return streamFrom([]);
      }),
      capabilities: {
        ...CAPABILITIES,
        models: ["fallback-model-a", "fallback-model-b"],
        voices: ["fallback-voice-a", "fallback-voice-b"],
        ttsSpeedRanges: [
          { model: "fallback-model-a", min: 0.6, max: 1.5 },
          { model: "fallback-model-b", min: 0.6, max: 1.5 },
        ],
      },
    } satisfies TextToSpeechProvider;
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      fallbackRequestVariants: [
        {
          when: { model: "primary-model", voice: "primary-voice" },
          fallback: { model: "fallback-model-a", voice: "fallback-voice-a" },
        },
        {
          when: { model: "primary-model", voice: "other-primary-voice" },
          fallback: { model: "fallback-model-b", voice: "fallback-voice-b" },
        },
      ],
    });

    await collect(await failover.synthesize({ ...request(), voice: "other-primary-voice" }));

    expect(fallbackRequests).toHaveLength(1);
    expect(fallbackRequests[0]).toMatchObject({
      model: "fallback-model-b",
      voice: "fallback-voice-b",
    });
  });

  it("rejects a request that matches no declared variant before the primary is called", async () => {
    const primarySynthesize = vi.fn(async () => streamFrom([]));
    const fallbackSynthesize = vi.fn(async () => streamFrom([]));
    const failover = createTtsFailoverProvider({
      primary: provider("primary-tts", primarySynthesize),
      fallback: {
        ...provider("fallback-tts", fallbackSynthesize),
        capabilities: { ...CAPABILITIES, voices: ["fallback-voice"] },
      },
      fallbackRequestVariants: [
        { when: { voice: "primary-voice" }, fallback: { voice: "fallback-voice" } },
      ],
    });

    await expect(
      failover.synthesize({ ...request(), voice: "unmatched-voice" }),
    ).rejects.toMatchObject({
      code: "provider.invalid_request",
      category: "validation",
      message: "TTS failover request matches no declared fallback request variant",
    });
    expect(primarySynthesize).not.toHaveBeenCalled();
    expect(fallbackSynthesize).not.toHaveBeenCalled();
  });

  it("rejects a request that matches several distinct variants before the primary is called", async () => {
    const primarySynthesize = vi.fn(async () => streamFrom([]));
    const fallbackSynthesize = vi.fn(async () => streamFrom([]));
    const failover = createTtsFailoverProvider({
      primary: provider("primary-tts", primarySynthesize),
      fallback: {
        ...provider("fallback-tts", fallbackSynthesize),
        capabilities: { ...CAPABILITIES, voices: ["fallback-voice-a", "fallback-voice-b"] },
      },
      fallbackRequestVariants: [
        { when: { voice: "primary-voice" }, fallback: { voice: "fallback-voice-a" } },
        { when: { model: "primary-model" }, fallback: { voice: "fallback-voice-b" } },
      ],
    });

    await expect(failover.synthesize(request())).rejects.toMatchObject({
      code: "provider.invalid_request",
      category: "validation",
      message: expect.stringMatching(/matches several fallback request variants/u),
    });
    expect(primarySynthesize).not.toHaveBeenCalled();
    expect(fallbackSynthesize).not.toHaveBeenCalled();
  });

  it("publishes no voice mappings when a variant cannot resolve a fallback voice", () => {
    const failover = createTtsFailoverProvider({
      primary: provider("primary", async () => streamFrom([])),
      fallback: provider("voiceless-fallback", async () => streamFrom([])),
      fallbackRequestVariants: [
        { when: { voice: "primary-voice" }, fallback: { voice: "fallback-voice" } },
        { fallback: { model: "fallback-model" } },
      ],
    });

    expect(failover.capabilities.ttsVoiceMappings).toBeUndefined();
  });

  it("publishes wildcard selectors in the voice mappings derived from variants", () => {
    const failover = createTtsFailoverProvider({
      primary: {
        ...provider("primary-tts", async () => streamFrom([])),
        configuredModel: "primary-model",
        configuredVoice: "primary-voice",
      },
      fallback: {
        ...provider("fallback-tts", async () => streamFrom([])),
        capabilities: { ...CAPABILITIES, voices: ["fallback-voice-a", "fallback-voice-b"] },
        configuredModel: "primary-model",
      },
      fallbackRequestVariants: [
        { when: { voice: "primary-voice" }, fallback: { voice: "fallback-voice-a" } },
        { fallback: { voice: "fallback-voice-b" } },
      ],
    });

    expect(failover.capabilities.ttsVoiceMappings).toEqual([
      {
        requestedVoice: "primary-voice",
        requestedProvider: "primary-tts",
        model: "primary-model",
        voice: "fallback-voice-a",
        provider: "fallback-tts",
      },
      {
        requestedProvider: "primary-tts",
        model: "primary-model",
        voice: "fallback-voice-b",
        provider: "fallback-tts",
      },
    ]);
  });

  it("isolates caller and fallback metadata from mutations made by the primary", async () => {
    const callerMetadata = { nested: { label: "original" } };
    const fallbackRequests: TtsSynthesisRequest[] = [];
    const primary = provider("primary-tts", async (value) => {
      (value.metadata?.nested as { label: string }).label = "primary mutation";
      throw TvicThrowableError.from(
        providerError("provider.upstream_failed", "primary unavailable", {
          provider: "primary-tts",
          retriable: true,
        }),
      );
    });
    const fallback = provider("fallback-tts", async (value) => {
      fallbackRequests.push(value);
      return streamFrom([]);
    });
    const failover = createTtsFailoverProvider({ primary, fallback });

    await collect(await failover.synthesize({ ...request(), metadata: callerMetadata }));

    expect(callerMetadata.nested.label).toBe("original");
    expect(fallbackRequests[0]?.metadata).toEqual({ nested: { label: "original" } });
  });

  it("declares capability requirements for a mapped fallback model", () => {
    const primary = {
      ...provider("primary-tts", async () => streamFrom([])),
      configuredModel: "primary-model",
      configuredVoice: "primary-voice",
    };
    const fallback = {
      ...provider("fallback-tts", async () => streamFrom([])),
      capabilities: {
        ...CAPABILITIES,
        models: ["fallback-model"],
        voices: ["fallback-voice"],
        modelSnapshotProviders: ["fallback-tts"],
      },
      configuredModel: "fallback-model",
      configuredVoice: "fallback-voice",
      requiredCapabilityQueriesForModel: (model: string) => [
        {
          provider: "fallback-tts",
          feature: "tts.model.available",
          scope: "model" as const,
          model,
        },
      ],
      supportsConfiguredModelSelection: (model: string) => model === "fallback-model",
    };
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      fallbackRequestVariants: [
        {
          when: { model: "primary-model", voice: "primary-voice" },
          fallback: { model: "fallback-model", voice: "fallback-voice" },
        },
      ],
    });

    expect(failover.capabilities.modelSnapshotProviders).toContain("fallback-tts");
    expect(failover.requiredCapabilityQueriesForModel?.("primary-model", "primary-voice")).toEqual([
      {
        provider: "fallback-tts",
        feature: "tts.model.available",
        scope: "model",
        model: "fallback-model",
      },
    ]);
    expect(failover.supportsConfiguredModelSelection?.("primary-model", "primary-voice")).toBe(
      true,
    );
  });

  it("rejects a mapped request that differs from its declared fallback selection", async () => {
    let fallbackCalls = 0;
    const fallback = {
      ...provider("account-fallback", async () => {
        fallbackCalls += 1;
        return streamFrom([]);
      }),
      capabilities: {
        ...CAPABILITIES,
        models: ["fallback-model"],
        voiceSelection: "account_snapshot" as const,
      },
    };
    const failover = createTtsFailoverProvider({
      primary: provider("primary-tts", async () => {
        throw TvicThrowableError.from(
          providerError("provider.upstream_failed", "primary unavailable", {
            provider: "primary-tts",
          }),
        );
      }),
      fallback,
      fallbackRequestVariants: [
        {
          when: { model: "primary-model", voice: "primary-voice" },
          fallback: { model: "fallback-model", voice: "declared-fallback-voice" },
        },
      ],
      mapFallbackRequest: (value) => ({
        ...value,
        model: "fallback-model",
        voice: "undeclared-fallback-voice",
      }),
    });

    await expect(failover.synthesize(request())).rejects.toMatchObject({
      code: "provider.upstream_failed",
      metadata: {
        fallbackValidationFailure: {
          code: TVIC_ERROR_CODES.providerInvalidRequest,
          message:
            "TTS failover mapping must match a declared fallback request variant; mismatched fallback fields: voice",
        },
      },
    });
    expect(fallbackCalls).toBe(0);
  });

  it("validates typed text controls against the primary before starting it", async () => {
    const primarySynthesize = vi.fn(async () => streamFrom([]));
    const primary: TextToSpeechProvider = {
      ...provider("primary-tts", primarySynthesize),
      capabilities: {
        ...CAPABILITIES,
        ttsTextControls: [{ model: "primary-model", controls: ["spell"] }],
      },
    };
    const fallbackSynthesize = vi.fn(async () => streamFrom([]));
    const fallback = provider("fallback-tts", fallbackSynthesize);
    const failover = createTtsFailoverProvider({ primary, fallback });

    await expect(
      failover.synthesize({
        ...request(),
        textControls: [{ type: "spell", match: "TVIC" }],
      }),
    ).resolves.toBeDefined();
    expect(primarySynthesize).toHaveBeenCalledOnce();
    expect(fallbackSynthesize).not.toHaveBeenCalled();
  });

  it("exposes primary text-control capabilities while preserving primary-call behavior", async () => {
    const primarySynthesize = vi.fn(async () => streamFrom([]));
    const primary: TextToSpeechProvider = {
      ...provider("primary-tts", primarySynthesize),
      capabilities: {
        ...CAPABILITIES,
        ttsTextControls: [{ model: "primary-model", controls: ["spell", "pause"] }],
      },
    };
    const fallback: TextToSpeechProvider = {
      ...provider("fallback-tts", async () => streamFrom([])),
      capabilities: {
        ...CAPABILITIES,
        ttsTextControls: [{ model: "primary-model", controls: ["spell"] }],
      },
    };
    const failover = createTtsFailoverProvider({ primary, fallback });

    expect(failover.capabilities.ttsTextControls).toEqual([
      { model: "primary-model", controls: ["spell", "pause"] },
    ]);
    await expect(
      failover.synthesize({
        ...request(),
        textControls: [{ type: "pause", match: "after this", durationMs: 250 }],
      }),
    ).resolves.toBeDefined();
    expect(primarySynthesize).toHaveBeenCalledOnce();
  });

  it("checks fallback text-control support only if failover is attempted", async () => {
    const primaryError = providerError("provider.upstream_failed", "primary unavailable", {
      provider: "primary-tts",
      retriable: true,
    });
    const primary = {
      ...provider("primary-tts", async () => {
        throw primaryError;
      }),
      capabilities: {
        ...CAPABILITIES,
        ttsTextControls: [{ model: "primary-model", controls: ["spell"] }],
      },
    } satisfies TextToSpeechProvider;
    const fallbackSynthesize = vi.fn(async () => streamFrom([]));
    const failover = createTtsFailoverProvider({
      primary,
      fallback: provider("fallback-tts", fallbackSynthesize),
    });

    await expect(
      failover.synthesize({
        ...request(),
        textControls: [{ type: "spell", match: "TVIC" }],
      }),
    ).rejects.toMatchObject({
      code: "provider.upstream_failed",
      provider: "primary-tts",
      metadata: { fallbackValidationFailure: { category: "validation", provider: "fallback-tts" } },
    });
    expect(fallbackSynthesize).not.toHaveBeenCalled();
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

  it("forwards each child’s serialized text count when the child reports exact usage", async () => {
    const reportedCharacters: number[] = [];
    const controls = [{ type: "spell" as const, match: "ABC" }];
    const childCapabilities = {
      ...CAPABILITIES,
      ttsTextControls: [{ model: "primary-model", controls: ["spell"] as const }],
    };
    const primary: TextToSpeechProvider = {
      ...provider("primary-tts", async (value) => {
        value.usageReporter?.reportTextCharacters(21);
        throw TvicThrowableError.from(
          providerError("provider.upstream_failed", "primary unavailable", {
            provider: "primary-tts",
            retriable: true,
          }),
        );
      }),
      capabilities: childCapabilities,
      usageAccounting: { reportsTextCharacters: true },
    };
    const fallback: TextToSpeechProvider = {
      ...provider("fallback-tts", async (value) => {
        value.usageReporter?.reportTextCharacters(21);
        return streamFrom([]);
      }),
      capabilities: childCapabilities,
      usageAccounting: { reportsTextCharacters: true },
    };
    const failover = createTtsFailoverProvider({ primary, fallback });

    await collect(
      await failover.synthesize({
        ...request(),
        text: "ABC",
        textControls: controls,
        usageReporter: {
          report() {},
          beginOperation() {
            throw new Error("unused");
          },
          reportTextCharacters(value) {
            reportedCharacters.push(value);
          },
        },
      }),
    );

    expect(reportedCharacters).toEqual([21, 21]);
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
      fallbackRequestVariants: [
        {
          when: { model: "primary-model", voice: "primary-voice" },
          fallback: { model: "eleven_flash_v2_5", voice: "eleven-voice" },
        },
      ],
      mapFallbackRequest: (value) => ({
        ...value,
        model: "eleven_flash_v2_5",
        voice: "eleven-voice",
      }),
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

  it.each([
    ["model and voice", {}],
    ["voice", { model: "fallback-model" }],
  ] as const)(
    "preflights sparse mapped fallback variants without primary %s IDs",
    async (_fields, fallbackVariant) => {
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
          models: ["fallback-model"],
          voices: ["fallback-voice"],
        },
      } satisfies TextToSpeechProvider;
      const failover = createTtsFailoverProvider({
        primary,
        fallback,
        mapFallbackRequest: (value) => ({
          ...value,
          model: "fallback-model",
          voice: "fallback-voice",
        }),
        fallbackRequestVariants: [{ fallback: fallbackVariant }],
      });

      expect(
        failover.supportsTtsSelection?.({ model: "primary-model", voice: "primary-voice" }),
      ).toBe(true);
      await expect(failover.synthesize(request()).then(collect)).resolves.toEqual([]);
      expect(fallbackRequests).toHaveLength(1);
      expect(fallbackRequests[0]).toMatchObject({
        model: "fallback-model",
        voice: "fallback-voice",
      });
    },
  );

  it("attributes mapped failover usage to the request model when variants preserve it", () => {
    const primary = provider("primary", async () => streamFrom([]));
    const fallback = provider("fallback", async () => streamFrom([]));
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      mapFallbackRequest: (value) => ({ ...value, voice: "fallback-voice" }),
      fallbackRequestVariants: [{ fallback: { voice: "fallback-voice" } }],
    });

    expect(failover.usageAccounting).toEqual({
      reportsTextCharacters: true,
      usesRequestModelForUsage: true,
    });
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

  it("uses the complete failover selection when checking provider compatibility", () => {
    const primary = {
      ...provider("primary-tts", async () => streamFrom([])),
      configuredModel: "primary-model",
      configuredVoice: "primary-voice",
      supportsTtsLanguage: (language: string) => language === "hi-IN",
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
      evaluateProviderCompatibility(failover, {
        kind: "tts",
        model: "primary-model",
        voice: "primary-voice",
        language: "hi-IN",
      }),
    ).toEqual({ compatible: true, issues: [] });
    expect(
      evaluateProviderCompatibility(failover, {
        kind: "tts",
        model: "primary-model",
        voice: "primary-voice",
        language: "or-IN",
      }),
    ).toMatchObject({
      compatible: false,
      issues: [{ code: "language.unsupported", requirement: "language" }],
    });
  });

  it("accepts a fallback variant that supplies its model-required language", () => {
    const primary = {
      ...provider("primary-tts", async () => streamFrom([])),
      configuredModel: "primary-model",
      configuredVoice: "primary-voice",
      capabilities: {
        ...CAPABILITIES,
        models: ["primary-model"],
        voices: ["primary-voice"],
      },
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
      requiresTtsLanguageForModel: (model?: string) => model === "fallback-model",
      supportsTtsLanguage: (language: string) => language === "hi-IN",
    } satisfies TextToSpeechProvider;
    const variants = [
      {
        fallback: {
          model: "fallback-model",
          voice: "fallback-voice",
          language: "hi-IN",
        },
      },
    ];
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      mapFallbackRequest: (value) => ({
        ...value,
        model: "fallback-model",
        voice: "fallback-voice",
        language: "hi-IN",
      }),
      fallbackRequestVariants: variants,
    });

    expect(failover.requiresTtsLanguageForModel?.("primary-model")).toBe(false);
    expect(
      failover.supportsTtsSelection?.({ model: "primary-model", voice: "primary-voice" }),
    ).toBe(true);
  });

  it("rejects fallback variants that change the call's selected speed", () => {
    const primary = provider("primary-tts", async () => streamFrom([]));
    const fallback = provider("fallback-tts", async () => streamFrom([]));

    expect(() =>
      createTtsFailoverProvider({
        primary,
        fallback,
        mapFallbackRequest: (value) => ({ ...value, speed: 1.2 }),
        fallbackRequestVariants: [{ fallback: { speed: 1.2 } } as never],
      }),
    ).toThrow(/fallback request variants cannot change per-call speed/u);
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

  it("supports mapper-only failover and validates the mapped request at call time", async () => {
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
    const fallbackRequests: TtsSynthesisRequest[] = [];
    const fallback = {
      ...provider("fallback-tts", async (value) => {
        fallbackCalls += 1;
        fallbackRequests.push(value);
        return streamFrom([]);
      }),
      configuredModel: "fallback-model",
      configuredVoice: "fallback-voice",
      capabilities: {
        ...CAPABILITIES,
        models: ["fallback-model"],
        voices: ["fallback-voice"],
      },
    } satisfies TextToSpeechProvider;
    const fallbackEvents: string[] = [];
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      languageMatch: "base-language",
      mapFallbackRequest: (value) => {
        mapperCalls += 1;
        return { ...value, model: "fallback-model", voice: "fallback-voice" };
      },
      onFallback: ({ phase, error }) => {
        fallbackEvents.push(`${phase}:${error.code}`);
      },
    });

    expect(
      failover.supportsTtsSelection?.({
        model: "primary-model",
        voice: "primary-voice",
      }),
    ).toBe(true);
    expect(failover.supportsTtsVoiceOverride?.("primary-voice", "primary-model")).toBe(true);
    await collect(await failover.synthesize(request()));
    expect(mapperCalls).toBe(1);
    expect(fallbackCalls).toBe(1);
    expect(fallbackRequests[0]).toMatchObject({ model: "fallback-model", voice: "fallback-voice" });
    expect(fallbackEvents).toEqual(["synthesize:provider.upstream_failed"]);
  });

  it("preflights and dispatches to a fallback with voices but no model catalog", async () => {
    const primary = {
      ...provider("primary-tts", async () => {
        throw TvicThrowableError.from(
          providerError("provider.upstream_failed", "primary unavailable", {
            provider: "primary-tts",
          }),
        );
      }),
      capabilities: { ...CAPABILITIES, models: ["primary-model"], voices: ["primary-voice"] },
      configuredModel: "primary-model",
      configuredVoice: "primary-voice",
    } satisfies TextToSpeechProvider;
    let fallbackCalls = 0;
    const { models: _models, ...capabilitiesWithoutModels } = CAPABILITIES;
    void _models;
    const fallback = {
      ...provider("fallback-tts", async () => {
        fallbackCalls += 1;
        return streamFrom([]);
      }),
      capabilities: { ...capabilitiesWithoutModels, voices: ["primary-voice"] },
    } satisfies TextToSpeechProvider;
    const failover = createTtsFailoverProvider({ primary, fallback });

    expect(
      failover.supportsTtsSelection?.({ model: "primary-model", voice: "primary-voice" }),
    ).toBe(true);
    await expect(failover.synthesize(request()).then(collect)).resolves.toEqual([]);
    expect(fallbackCalls).toBe(1);
  });

  it("keeps identity-mapped primary settings when the fallback only declares defaults", async () => {
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
    let receivedFallbackRequest: TtsSynthesisRequest | undefined;
    const { models: _models, voices: _voices, ...capabilitiesWithoutModelOrVoice } = CAPABILITIES;
    void _models;
    void _voices;
    const fallback = {
      ...provider("fallback-tts", async (value) => {
        fallbackCalls += 1;
        receivedFallbackRequest = value;
        return streamFrom([]);
      }),
      configuredModel: "fallback-default-model",
      configuredVoice: "fallback-default-voice",
      capabilities: capabilitiesWithoutModelOrVoice,
    } satisfies TextToSpeechProvider;
    const failover = createTtsFailoverProvider({ primary, fallback });

    expect(
      failover.supportsTtsSelection?.({ model: "primary-model", voice: "primary-voice" }),
    ).toBe(true);
    await expect(failover.synthesize(request()).then(collect)).resolves.toEqual([]);
    expect(fallbackCalls).toBe(1);
    expect(receivedFallbackRequest).toMatchObject({
      model: "primary-model",
      voice: "primary-voice",
    });
  });

  it("passes a fallback's configured language to its selection check in preflight and dispatch", async () => {
    const primary = {
      ...provider("primary-tts", async () => {
        throw TvicThrowableError.from(
          providerError("provider.upstream_failed", "primary unavailable", {
            provider: "primary-tts",
          }),
        );
      }),
      configuredModel: "shared-model",
      configuredVoice: "shared-voice",
      configuredLanguage: "en",
      capabilities: { ...CAPABILITIES, models: ["shared-model"], voices: ["shared-voice"] },
    } satisfies TextToSpeechProvider;
    const observedSelections: Array<string | undefined> = [];
    let fallbackRequestLanguage: string | undefined;
    const fallback = {
      ...provider("fallback-tts", async (value) => {
        fallbackRequestLanguage = value.language;
        return streamFrom([]);
      }),
      configuredModel: "shared-model",
      configuredVoice: "shared-voice",
      configuredLanguage: "en",
      capabilities: { ...CAPABILITIES, models: ["shared-model"], voices: ["shared-voice"] },
      supportsTtsSelection: (selection) => {
        observedSelections.push(selection.language);
        return selection.language === "en";
      },
    } satisfies TextToSpeechProvider;
    const failover = createTtsFailoverProvider({ primary, fallback });

    expect(failover.supportsTtsSelection?.({ model: "shared-model", voice: "shared-voice" })).toBe(
      true,
    );
    await expect(failover.synthesize(requestWithoutModelOrVoice()).then(collect)).resolves.toEqual(
      [],
    );
    expect(observedSelections).toEqual(["en", "en"]);
    expect(fallbackRequestLanguage).toBeUndefined();
  });

  it("constructs the documented Sarvam to ElevenLabs fallback with matching languages", () => {
    const sarvam = createSarvamTtsHttpStreamProvider({
      apiKey: "sarvam-secret",
      voiceId: "shubh",
      language: "en-IN",
    });
    const elevenLabs = createElevenLabsTtsHttpStreamProvider({
      apiKey: "elevenlabs-secret",
      voiceId: "fallback-voice",
      modelId: "eleven_flash_v2_5",
      language: "en-IN",
    });
    const failover = createTtsFailoverProvider({
      primary: sarvam,
      fallback: elevenLabs,
      mapFallbackRequest: (value) => ({
        ...value,
        model: "eleven_flash_v2_5",
        voice: "fallback-voice",
      }),
      fallbackRequestVariants: [
        { fallback: { model: "eleven_flash_v2_5", voice: "fallback-voice" } },
      ],
    });

    expect(failover.supportsTtsSelection?.({ model: "bulbul:v3", voice: "shubh" })).toBe(true);
  });

  it("matches base-language fallback variants against the primary configured language", async () => {
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
      configuredLanguage: "en-IN",
      supportsTtsLanguage: (language: string) => language === "en-IN",
    } satisfies TextToSpeechProvider;
    const fallbackRequests: TtsSynthesisRequest[] = [];
    const fallback = {
      ...provider("fallback-tts", async (value) => {
        fallbackRequests.push(value);
        return streamFrom([]);
      }),
      configuredLanguage: "en",
      supportsTtsSelection: (selection) =>
        selection.model === "fallback-model" &&
        selection.voice === "fallback-voice" &&
        selection.language === "en",
    } satisfies TextToSpeechProvider;
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      languageMatch: "base-language",
      mapFallbackRequest: (value) => ({
        ...value,
        model: "fallback-model",
        voice: "fallback-voice",
        language: "en",
      }),
      fallbackRequestVariants: [
        {
          when: { language: "en" },
          fallback: { model: "fallback-model", voice: "fallback-voice", language: "en" },
        },
      ],
    });

    expect(
      failover.supportsTtsSelection?.({
        model: "primary-model",
        voice: "primary-voice",
      }),
    ).toBe(true);
    await expect(failover.synthesize(requestWithoutModelOrVoice()).then(collect)).resolves.toEqual(
      [],
    );
    expect(fallbackRequests).toHaveLength(1);
    expect(fallbackRequests[0]).toMatchObject({
      model: "fallback-model",
      voice: "fallback-voice",
      language: "en",
    });
  });

  it("does not dispatch an inherited primary language to a base-language fallback", async () => {
    const primary = {
      ...provider("primary-tts", async () => {
        throw TvicThrowableError.from(
          providerError("provider.upstream_failed", "primary unavailable", {
            provider: "primary-tts",
          }),
        );
      }),
      configuredLanguage: "en",
      supportsTtsLanguage: (language: string) => language === "en",
    } satisfies TextToSpeechProvider;
    const fallback = createSarvamTtsProvider({
      apiKey: "sarvam-secret",
      modelId: "bulbul:v3",
      voiceId: "shubh",
      language: "en-IN",
    });
    const fallbackSynthesize = vi.spyOn(fallback, "synthesize").mockResolvedValue(streamFrom([]));
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      languageMatch: "base-language",
      mapFallbackRequest: (value) => ({ ...value, model: "bulbul:v3", voice: "shubh" }),
      fallbackRequestVariants: [{ fallback: { model: "bulbul:v3", voice: "shubh" } }],
    });
    const inheritedLanguageRequest = {
      ...request(),
      language: "en",
      selectionContext: { languageWasCallerSelected: false },
    };

    expect(
      failover.supportsTtsSelection?.(
        { model: "primary-model", voice: "primary-voice", language: "en" },
        { languageWasCallerSelected: false },
      ),
    ).toBe(true);
    await expect(failover.synthesize(inheritedLanguageRequest).then(collect)).resolves.toEqual([]);
    expect(fallbackSynthesize).toHaveBeenCalledOnce();
    expect(fallbackSynthesize.mock.calls[0]?.[0].language).toBeUndefined();
  });

  it("uses a base-language variant's declared tag at fallback dispatch", async () => {
    const primary = {
      ...provider("primary-tts", async () => {
        throw TvicThrowableError.from(
          providerError("provider.upstream_failed", "primary unavailable", {
            provider: "primary-tts",
          }),
        );
      }),
      configuredLanguage: "en",
      supportsTtsLanguage: (language: string) => language === "en",
    } satisfies TextToSpeechProvider;
    const fallback = createSarvamTtsProvider({
      apiKey: "sarvam-secret",
      modelId: "bulbul:v3",
      voiceId: "shubh",
      language: "en-IN",
    });
    const fallbackSynthesize = vi.spyOn(fallback, "synthesize").mockResolvedValue(streamFrom([]));
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      languageMatch: "base-language",
      mapFallbackRequest: (value) => ({ ...value, model: "bulbul:v3", voice: "shubh" }),
      fallbackRequestVariants: [
        {
          when: { language: "en" },
          fallback: { model: "bulbul:v3", voice: "shubh", language: "en-IN" },
        },
      ],
    });

    await expect(
      failover
        .synthesize({
          ...request(),
          language: "en",
          selectionContext: { languageWasCallerSelected: false },
        })
        .then(collect),
    ).resolves.toEqual([]);
    expect(fallbackSynthesize.mock.calls[0]?.[0].language).toBe("en-IN");
  });

  it("preserves a mapper's explicit regional language when a base-language variant matches", async () => {
    const primary = {
      ...provider("primary-tts", async () => {
        throw TvicThrowableError.from(
          providerError("provider.upstream_failed", "primary unavailable", {
            provider: "primary-tts",
          }),
        );
      }),
      configuredLanguage: "en-IN",
      supportsTtsLanguage: () => true,
    } satisfies TextToSpeechProvider;
    const fallbackRequests: TtsSynthesisRequest[] = [];
    const fallback = {
      ...provider("fallback-tts", async (value) => {
        fallbackRequests.push(value);
        return streamFrom([]);
      }),
      configuredLanguage: "en",
      supportsTtsLanguage: () => true,
    } satisfies TextToSpeechProvider;
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      languageMatch: "base-language",
      mapFallbackRequest: (value) => ({ ...value, language: "en-GB" }),
      fallbackRequestVariants: [{ fallback: { language: "en" } }],
    });

    await expect(
      failover
        .synthesize({
          ...request(),
          language: "en",
          selectionContext: {
            languageWasExplicitlySelected: true,
            languageWasCallerSelected: true,
          },
        })
        .then(collect),
    ).resolves.toEqual([]);
    expect(fallbackRequests[0]?.language).toBe("en-GB");
  });

  it("preserves enumerable extension fields on mapped request snapshots", async () => {
    const primary = provider("primary-tts", async () => {
      throw TvicThrowableError.from(
        providerError("provider.upstream_failed", "primary unavailable", {
          provider: "primary-tts",
        }),
      );
    });
    const fallbackRequests: Array<TtsSynthesisRequest & { tenantContext?: { tenantId: string } }> =
      [];
    const fallback = {
      ...provider("fallback-tts", async (value) => {
        fallbackRequests.push(
          value as TtsSynthesisRequest & { tenantContext?: { tenantId: string } },
        );
        return streamFrom([]);
      }),
      capabilities: { ...CAPABILITIES, models: ["primary-model", "fallback-model"] },
    } satisfies TextToSpeechProvider;
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      mapFallbackRequest: (value) => ({ ...value, model: "fallback-model" }),
      fallbackRequestVariants: [{ fallback: { model: "fallback-model" } }],
    });
    const extendedRequest = {
      ...request(),
      tenantContext: { tenantId: "tenant-17" },
    } as TtsSynthesisRequest & { tenantContext: { tenantId: string } };

    await expect(failover.synthesize(extendedRequest).then(collect)).resolves.toEqual([]);
    expect(fallbackRequests[0]?.tenantContext).toEqual({ tenantId: "tenant-17" });
  });

  it("re-attaches the caller's selection provenance after the mapper runs", async () => {
    const primary = provider("primary-tts", async () => {
      throw TvicThrowableError.from(
        providerError("provider.upstream_failed", "primary unavailable", {
          provider: "primary-tts",
        }),
      );
    });
    const fallbackRequests: TtsSynthesisRequest[] = [];
    const fallback = {
      ...provider("fallback-tts", async (value) => {
        fallbackRequests.push(value);
        return streamFrom([]);
      }),
      capabilities: { ...CAPABILITIES, models: ["primary-model", "fallback-model"] },
    } satisfies TextToSpeechProvider;
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      mapFallbackRequest: (value) => ({
        ...value,
        model: "fallback-model",
        selectionContext: { languageWasCallerSelected: true },
      }),
      fallbackRequestVariants: [{ fallback: { model: "fallback-model" } }],
    });

    await collect(
      await failover.synthesize({
        ...request(),
        selectionContext: { languageWasCallerSelected: false },
      }),
    );

    expect(fallbackRequests).toHaveLength(1);
    expect(fallbackRequests[0]).toMatchObject({
      model: "fallback-model",
      selectionContext: { languageWasCallerSelected: false },
    });
  });

  it("accepts a mapper that rebuilds the request without its selection provenance", async () => {
    const fallbackRequests: TtsSynthesisRequest[] = [];
    const failover = createTtsFailoverProvider({
      primary: provider("primary-tts", async () => {
        throw TvicThrowableError.from(
          providerError("provider.upstream_failed", "primary unavailable", {
            provider: "primary-tts",
          }),
        );
      }),
      fallback: provider("fallback-tts", async (value) => {
        fallbackRequests.push(value);
        return streamFrom([]);
      }),
      mapFallbackRequest: (value) => ({
        sessionId: value.sessionId,
        turnId: value.turnId,
        format: value.format,
        text: value.text,
        stream: value.stream,
        model: value.model!,
        voice: value.voice!,
      }),
    });

    await collect(
      await failover.synthesize({
        ...request(),
        selectionContext: { languageWasCallerSelected: false },
      }),
    );

    expect(fallbackRequests[0]?.selectionContext).toEqual({ languageWasCallerSelected: false });
  });

  it("matches language-requiring variants against voice and speed conditions", () => {
    const primary = {
      ...provider("primary-tts", async () => streamFrom([])),
      supportsTtsSpeed: () => true,
      supportsTtsVoiceOverride: () => true,
    } satisfies TextToSpeechProvider;
    const fallback = {
      ...provider("fallback-tts", async () => streamFrom([])),
      configuredModel: "fallback-model",
      capabilities: {
        ...CAPABILITIES,
        models: ["fallback-model"],
        voices: ["fallback-voice"],
      },
      requiresTtsLanguageForModel: (model?: string) => model === "fallback-model",
      supportsTtsLanguage: () => true,
      supportsTtsSpeed: () => true,
      supportsTtsVoiceOverride: () => true,
    } satisfies TextToSpeechProvider;
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      mapFallbackRequest: (value) => ({
        ...value,
        model: "fallback-model",
        voice: "fallback-voice",
        ...(value.voice === "other-primary-voice" ? { language: "en-IN" } : {}),
      }),
      fallbackRequestVariants: [
        {
          when: { voice: "primary-voice", speed: 1.1 },
          fallback: { model: "fallback-model", voice: "fallback-voice" },
        },
        {
          when: { voice: "other-primary-voice", speed: 1.2 },
          fallback: { model: "fallback-model", voice: "fallback-voice", language: "en-IN" },
        },
      ],
    });

    expect(
      failover.supportsTtsSelection?.({
        model: "primary-model",
        voice: "other-primary-voice",
        speed: 1.2,
      }),
    ).toBe(true);
  });

  it("turns a throwing fallback requirement hook into a conservative preflight result", () => {
    const primary = provider("primary-tts", async () => streamFrom([]));
    const fallback = {
      ...provider("fallback-tts", async () => streamFrom([])),
      requiresTtsLanguageForModel() {
        throw new Error("provider hook failure");
      },
    } satisfies TextToSpeechProvider;

    const failover = createTtsFailoverProvider({ primary, fallback });
    expect(failover.supportsTtsSelection?.({})).toBe(false);
  });

  it("dispatches a variant-only language when the mapper omits language", async () => {
    const primary = {
      ...provider("primary-tts", async () => {
        throw TvicThrowableError.from(
          providerError("provider.upstream_failed", "primary unavailable", {
            provider: "primary-tts",
          }),
        );
      }),
      configuredLanguage: "en",
      requiresTtsLanguageForModel: () => true,
      supportsTtsLanguage: (language: string) => language === "en",
    } satisfies TextToSpeechProvider;
    const fallbackRequests: TtsSynthesisRequest[] = [];
    const fallback = {
      ...provider("regional-fallback-tts", async (value) => {
        fallbackRequests.push(value);
        return streamFrom([]);
      }),
      configuredModel: SARVAM_TTS_V4_FLASH_MODEL,
      configuredVoice: "simran_en_customer",
      configuredLanguage: "en-GB",
      languageWasExplicitlyConfigured: false,
      requiresTtsLanguageForModel: () => true,
      supportsTtsLanguage: (language: string) => language === "en-IN",
      supportsTtsSelection: (selection) =>
        selection.model === SARVAM_TTS_V4_FLASH_MODEL &&
        selection.voice === "simran_en_customer" &&
        selection.language === "en-IN",
    } satisfies TextToSpeechProvider;
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      languageMatch: "base-language",
      mapFallbackRequest: (value) => {
        const { language: _language, ...withoutLanguage } = value;
        void _language;
        return {
          ...withoutLanguage,
          model: SARVAM_TTS_V4_FLASH_MODEL,
          voice: "simran_en_customer",
        };
      },
      fallbackRequestVariants: [
        {
          when: { language: "en" },
          fallback: {
            model: SARVAM_TTS_V4_FLASH_MODEL,
            voice: "simran_en_customer",
            language: "en-IN",
          },
        },
      ],
    });
    const inheritedLanguageRequest = {
      ...request(),
      language: "en",
      selectionContext: { languageWasCallerSelected: false },
    };

    expect(
      failover.supportsTtsSelection?.(
        { model: "primary-model", voice: "primary-voice", language: "en" },
        { languageWasCallerSelected: false },
      ),
    ).toBe(true);
    await expect(failover.synthesize(inheritedLanguageRequest).then(collect)).resolves.toEqual([]);
    expect(fallbackRequests).toHaveLength(1);
    expect(fallbackRequests[0]).toMatchObject({
      model: SARVAM_TTS_V4_FLASH_MODEL,
      voice: "simran_en_customer",
      language: "en-IN",
    });
  });

  it.each([
    {
      sourceLanguage: "en-IN",
      fallbackLanguage: "en-IN",
      fallbackConfiguredLanguage: "en-IN",
      languageMatch: "exact" as const,
    },
    {
      sourceLanguage: "en-US",
      fallbackLanguage: "en-IN",
      fallbackConfiguredLanguage: "en-GB",
      languageMatch: "base-language" as const,
    },
  ])(
    "dispatches caller language $sourceLanguage through a $languageMatch variant when the mapper omits it",
    async ({ sourceLanguage, fallbackLanguage, fallbackConfiguredLanguage, languageMatch }) => {
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
        configuredLanguage: sourceLanguage,
        supportsTtsLanguage: (language: string) => language === sourceLanguage,
      } satisfies TextToSpeechProvider;
      const fallbackRequests: TtsSynthesisRequest[] = [];
      const fallback = {
        ...provider("fallback-tts", async (value) => {
          fallbackRequests.push(value);
          return streamFrom([]);
        }),
        configuredModel: "fallback-model",
        configuredVoice: "fallback-voice",
        configuredLanguage: fallbackConfiguredLanguage,
        languageWasExplicitlyConfigured: false,
        requiresTtsLanguageForModel: () => true,
        supportsTtsLanguage: (language: string) => language === fallbackLanguage,
        supportsTtsSelection: (selection) =>
          selection.model === "fallback-model" &&
          selection.voice === "fallback-voice" &&
          selection.language === fallbackLanguage,
      } satisfies TextToSpeechProvider;
      const failover = createTtsFailoverProvider({
        primary,
        fallback,
        languageMatch,
        mapFallbackRequest: (value) => {
          const { language: _language, ...withoutLanguage } = value;
          void _language;
          return {
            ...withoutLanguage,
            model: "fallback-model",
            voice: "fallback-voice",
          };
        },
        fallbackRequestVariants: [
          {
            when: { language: sourceLanguage },
            fallback: {
              model: "fallback-model",
              voice: "fallback-voice",
              language: fallbackLanguage,
            },
          },
        ],
      });
      const callerRequest = {
        ...request(),
        model: "primary-model",
        voice: "primary-voice",
        language: sourceLanguage,
        selectionContext: { languageWasCallerSelected: true },
      };

      expect(
        failover.supportsTtsSelection?.(
          { model: "primary-model", voice: "primary-voice", language: sourceLanguage },
          { languageWasCallerSelected: true },
        ),
      ).toBe(true);
      await expect(failover.synthesize(callerRequest).then(collect)).resolves.toEqual([]);
      expect(fallbackRequests).toHaveLength(1);
      expect(fallbackRequests[0]).toMatchObject({
        model: "fallback-model",
        voice: "fallback-voice",
        language: fallbackLanguage,
      });
    },
  );

  it.each([
    {
      sourceLanguage: "hi-IN",
      fallbackLanguage: "en-IN",
      languageMatch: "base-language" as const,
      mapperLanguage: "en-IN",
      supported: false,
    },
    {
      sourceLanguage: "en-US",
      fallbackLanguage: "en-IN",
      languageMatch: "exact" as const,
      supported: false,
    },
    {
      sourceLanguage: "en-US",
      fallbackLanguage: "en-IN",
      languageMatch: "base-language" as const,
      supported: true,
    },
  ])(
    "keeps a caller-selected $sourceLanguage compatible with fallback $fallbackLanguage ($languageMatch)",
    async ({ sourceLanguage, fallbackLanguage, languageMatch, mapperLanguage, supported }) => {
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
        requiresTtsLanguageForModel: () => true,
        supportsTtsLanguage: (language: string) => language === sourceLanguage,
      } satisfies TextToSpeechProvider;
      const fallbackRequests: TtsSynthesisRequest[] = [];
      const fallback = {
        ...provider("fallback-tts", async (value) => {
          fallbackRequests.push(value);
          return streamFrom([]);
        }),
        configuredModel: "fallback-model",
        configuredVoice: "fallback-voice",
        languageWasExplicitlyConfigured: false,
        requiresTtsLanguageForModel: () => true,
        supportsTtsLanguage: (language: string) => language === fallbackLanguage,
        supportsTtsSelection: (selection) =>
          selection.model === "fallback-model" &&
          selection.voice === "fallback-voice" &&
          selection.language === fallbackLanguage,
      } satisfies TextToSpeechProvider;
      const failover = createTtsFailoverProvider({
        primary,
        fallback,
        languageMatch,
        mapFallbackRequest: (value) => ({
          ...value,
          model: "fallback-model",
          voice: "fallback-voice",
          ...(mapperLanguage !== undefined ? { language: mapperLanguage } : {}),
        }),
        fallbackRequestVariants: [
          {
            fallback: {
              model: "fallback-model",
              voice: "fallback-voice",
              language: fallbackLanguage,
            },
          },
        ],
      });
      const callerRequest = {
        ...request(),
        language: sourceLanguage,
        selectionContext: { languageWasCallerSelected: true },
      };
      const preflight = failover.supportsTtsSelection?.(
        {
          model: "primary-model",
          voice: "primary-voice",
          language: sourceLanguage,
        },
        { languageWasCallerSelected: true },
      );

      expect(preflight).toBe(supported);
      if (supported) {
        await expect(failover.synthesize(callerRequest).then(collect)).resolves.toEqual([]);
        expect(fallbackRequests).toHaveLength(1);
        expect(fallbackRequests[0]?.language).toBe(fallbackLanguage);
      } else {
        await expect(failover.synthesize(callerRequest).then(collect)).rejects.toMatchObject({
          code: TVIC_ERROR_CODES.providerUpstreamFailed,
        });
        expect(fallbackRequests).toHaveLength(0);
      }
    },
  );

  it("allows a mapped failover variant to inherit the per-call language", async () => {
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
      configuredLanguage: "en-IN",
      supportsTtsLanguage: () => true,
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
        voices: ["fallback-voice"],
      },
      configuredLanguage: "en-IN",
      languageWasExplicitlyConfigured: false,
      requiresTtsLanguageForModel: () => true,
      supportsTtsLanguage: (language: string) => language === "hi-IN",
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
    const requestWithLanguage = { ...request(), language: "hi-IN" };

    expect(failover.supportsTtsSelection?.({ language: "hi-IN" })).toBe(true);
    await expect(failover.synthesize(requestWithLanguage).then(collect)).resolves.toEqual([]);
    expect(fallbackRequests[0]).toMatchObject({
      model: "fallback-model",
      voice: "fallback-voice",
      language: "hi-IN",
    });
  });

  it("preflights a Sarvam v4 fallback language inherited from the per-call request", async () => {
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
      configuredLanguage: "en-IN",
      supportsTtsLanguage: (language: string) => language === "en-IN",
    } satisfies TextToSpeechProvider;
    const fallback = createSarvamTtsProvider({
      apiKey: "sarvam-secret",
      modelId: SARVAM_TTS_V4_FLASH_MODEL,
    });
    const fallbackRequests: TtsSynthesisRequest[] = [];
    vi.spyOn(fallback, "synthesize").mockImplementation(async (value) => {
      fallbackRequests.push(value);
      return streamFrom([]);
    });
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      mapFallbackRequest: (value) => ({
        ...value,
        model: SARVAM_TTS_V4_FLASH_MODEL,
        voice: "simran_en_customer",
      }),
      fallbackRequestVariants: [
        { fallback: { model: SARVAM_TTS_V4_FLASH_MODEL, voice: "simran_en_customer" } },
      ],
    });
    const requestWithLanguage = { ...request(), language: "en-IN" };

    expect(failover.supportsTtsSelection?.({ language: "en-IN" })).toBe(true);
    await expect(failover.synthesize(requestWithLanguage).then(collect)).resolves.toEqual([]);
    expect(fallbackRequests).toHaveLength(1);
    expect(fallbackRequests[0]).toMatchObject({
      model: SARVAM_TTS_V4_FLASH_MODEL,
      voice: "simran_en_customer",
      language: "en-IN",
    });
  });

  it.each(["mapper", "variant"] as const)(
    "treats a %s-supplied language as explicit at Sarvam v4 failover dispatch",
    async (languageSource) => {
      const primary = {
        ...provider("primary-tts", async () => {
          throw TvicThrowableError.from(
            providerError("provider.upstream_failed", "primary unavailable", {
              provider: "primary-tts",
              retriable: true,
            }),
          );
        }),
        configuredModel: "eleven_v3",
        configuredVoice: "primary-voice",
        configuredLanguage: "en-IN",
        languageWasExplicitlyConfigured: true,
        supportsTtsLanguage: (language: string) => language === "en-IN",
      } satisfies TextToSpeechProvider;
      const fallback = createSarvamTtsProvider({
        apiKey: "sarvam-secret",
        modelId: SARVAM_TTS_V4_FLASH_MODEL,
      });
      const fallbackSynthesize = vi.spyOn(fallback, "synthesize").mockResolvedValue(streamFrom([]));
      const failover = createTtsFailoverProvider({
        primary,
        fallback,
        mapFallbackRequest: (value) => ({
          ...value,
          model: SARVAM_TTS_V4_FLASH_MODEL,
          voice: "simran_en_customer",
          language: "en-IN",
        }),
        ...(languageSource === "variant"
          ? {
              fallbackRequestVariants: [
                {
                  fallback: {
                    model: SARVAM_TTS_V4_FLASH_MODEL,
                    voice: "simran_en_customer",
                    language: "en-IN",
                  },
                },
              ],
            }
          : {}),
      });

      expect(
        failover.supportsTtsSelection?.(
          { model: "eleven_v3", voice: "primary-voice", language: "en-IN" },
          { languageWasCallerSelected: false },
        ),
      ).toBe(true);
      await expect(
        failover
          .synthesize({
            ...requestWithoutModelOrVoice(),
            selectionContext: { languageWasCallerSelected: false },
          })
          .then(collect),
      ).resolves.toEqual([]);
      expect(fallbackSynthesize).toHaveBeenCalledOnce();
      expect(fallbackSynthesize.mock.calls[0]?.[0]).toMatchObject({
        model: SARVAM_TTS_V4_FLASH_MODEL,
        voice: "simran_en_customer",
        language: "en-IN",
        selectionContext: { languageWasCallerSelected: false },
      });
    },
  );

  it("uses fallback language defaults when a base-language variant omits language", async () => {
    const primary = {
      ...provider("primary-tts", async () => {
        throw TvicThrowableError.from(
          providerError("provider.upstream_failed", "primary unavailable", {
            provider: "primary-tts",
          }),
        );
      }),
      configuredModel: "eleven_flash_v2_5",
      configuredVoice: "primary-voice",
      configuredLanguage: "en",
      supportsTtsLanguage: (language: string) => language === "en",
    } satisfies TextToSpeechProvider;
    const fallbackRequests: TtsSynthesisRequest[] = [];
    const fallback = {
      ...provider("fallback-tts", async (value) => {
        fallbackRequests.push(value);
        return streamFrom([]);
      }),
      configuredModel: "bulbul:v3",
      configuredVoice: "fallback-voice",
      configuredLanguage: "en-IN",
      supportsTtsSelection: (selection) =>
        selection.model === "bulbul:v3" &&
        selection.voice === "fallback-voice" &&
        selection.language === "en-IN",
    } satisfies TextToSpeechProvider;
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      languageMatch: "base-language",
      mapFallbackRequest: (value) => ({
        ...value,
        model: "bulbul:v3",
        voice: "fallback-voice",
        language: "en-IN",
      }),
      fallbackRequestVariants: [
        {
          when: { language: "en-IN" },
          fallback: { model: "bulbul:v3", voice: "fallback-voice" },
        },
      ],
    });

    expect(failover.supportsTtsSelection?.({ model: "eleven_flash_v2_5" })).toBe(true);
    await expect(failover.synthesize(requestWithoutModelOrVoice()).then(collect)).resolves.toEqual(
      [],
    );
    expect(fallbackRequests[0]).toMatchObject({
      model: "bulbul:v3",
      voice: "fallback-voice",
      language: "en-IN",
    });
  });

  it("does not treat the primary configured language as a caller language for fallback preflight", () => {
    const primary = {
      ...provider("primary-tts", async () => streamFrom([])),
      configuredModel: "eleven_flash_v2_5",
      configuredVoice: "primary-voice",
      configuredLanguage: "en",
      capabilities: {
        ...CAPABILITIES,
        models: ["eleven_flash_v2_5"],
      },
      supportsTtsLanguage: (language: string) => language === "en",
    } satisfies TextToSpeechProvider;
    const fallback = createSarvamTtsProvider({
      apiKey: "sarvam-secret",
      modelId: "bulbul:v3",
      voiceId: "shubh",
    });
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      languageMatch: "base-language",
      mapFallbackRequest: (value) => ({ ...value, model: "bulbul:v3", voice: "shubh" }),
      fallbackRequestVariants: [{ fallback: { model: "bulbul:v3", voice: "shubh" } }],
    });

    expect(
      failover.supportsTtsSelection?.(
        { model: "eleven_flash_v2_5", voice: "primary-voice", language: "en" },
        { languageWasCallerSelected: false },
      ),
    ).toBe(true);
  });

  it("rejects an inherited custom-primary language before Sarvam v4 fallback dispatch", async () => {
    const primary = {
      ...provider("custom-primary-tts", async () => {
        throw TvicThrowableError.from(
          providerError("provider.upstream_failed", "primary unavailable", {
            provider: "custom-primary-tts",
          }),
        );
      }),
      configuredModel: "host-model",
      configuredVoice: "host-voice",
      configuredLanguage: "en",
      requiresTtsLanguageForModel: () => true,
      supportsTtsLanguage: (language: string) => language === "en",
    } satisfies TextToSpeechProvider;
    const fallback = createSarvamTtsProvider({
      apiKey: "sarvam-secret",
      modelId: SARVAM_TTS_V4_FLASH_MODEL,
    });
    const fallbackSynthesize = vi.spyOn(fallback, "synthesize").mockResolvedValue(streamFrom([]));
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      languageMatch: "base-language",
      mapFallbackRequest: (value) => ({
        ...value,
        model: SARVAM_TTS_V4_FLASH_MODEL,
        voice: "simran_en_customer",
      }),
      fallbackRequestVariants: [
        {
          when: { language: "en" },
          fallback: { model: SARVAM_TTS_V4_FLASH_MODEL, voice: "simran_en_customer" },
        },
      ],
    });
    const selection = {
      model: "host-model",
      voice: "host-voice",
      language: "en",
    };

    expect(failover.supportsTtsSelection?.(selection, { languageWasCallerSelected: false })).toBe(
      false,
    );
    await expect(
      failover
        .synthesize({
          ...requestWithoutModelOrVoice(),
          ...selection,
          selectionContext: { languageWasCallerSelected: false },
        })
        .then(collect),
    ).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerUpstreamFailed,
      message: "primary unavailable",
    });
    expect(fallbackSynthesize).not.toHaveBeenCalled();
  });

  it("rejects an unselected primary default when a Sarvam v4 fallback needs caller language", () => {
    const primary = {
      ...provider("primary-tts", async () => streamFrom([])),
      configuredModel: "eleven_flash_v2_5",
      configuredVoice: "primary-voice",
      configuredLanguage: "en-IN",
      languageWasExplicitlyConfigured: true,
      capabilities: {
        ...CAPABILITIES,
        models: ["eleven_flash_v2_5"],
      },
      supportsTtsLanguage: (language: string) => language === "en-IN",
    } satisfies TextToSpeechProvider;
    const fallback = createSarvamTtsProvider({
      apiKey: "sarvam-secret",
      modelId: SARVAM_TTS_V4_FLASH_MODEL,
    });
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      mapFallbackRequest: (value) => ({
        ...value,
        model: SARVAM_TTS_V4_FLASH_MODEL,
        voice: "simran_en_customer",
      }),
      fallbackRequestVariants: [
        { fallback: { model: SARVAM_TTS_V4_FLASH_MODEL, voice: "simran_en_customer" } },
      ],
    });
    const inheritedSelection = { model: "eleven_flash_v2_5", language: "en-IN" };

    expect(
      failover.supportsTtsSelection?.(inheritedSelection, { languageWasCallerSelected: false }),
    ).toBe(false);
    expect(
      failover.supportsTtsSelection?.(inheritedSelection, { languageWasCallerSelected: true }),
    ).toBe(true);
  });

  it("keeps an inherited primary language from satisfying Sarvam v4 at failover dispatch", async () => {
    const primary = {
      ...provider("primary-tts", async () => {
        throw TvicThrowableError.from(
          providerError("provider.upstream_failed", "primary unavailable", {
            provider: "primary-tts",
            retriable: true,
          }),
        );
      }),
      configuredModel: "eleven_flash_v2_5",
      configuredVoice: "primary-voice",
      configuredLanguage: "en-IN",
      languageWasExplicitlyConfigured: true,
      supportsTtsLanguage: (language: string) => language === "en-IN",
    } satisfies TextToSpeechProvider;
    const fallback = createSarvamTtsProvider({
      apiKey: "sarvam-secret",
      modelId: SARVAM_TTS_V4_FLASH_MODEL,
    });
    const fallbackSynthesize = vi.spyOn(fallback, "synthesize").mockResolvedValue(streamFrom([]));
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      mapFallbackRequest: (value) => ({
        ...value,
        model: SARVAM_TTS_V4_FLASH_MODEL,
        voice: "simran_en_customer",
      }),
      fallbackRequestVariants: [
        { fallback: { model: SARVAM_TTS_V4_FLASH_MODEL, voice: "simran_en_customer" } },
      ],
    });

    await expect(
      failover.synthesize({
        ...request(),
        language: "en-IN",
        selectionContext: { languageWasCallerSelected: false },
      }),
    ).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerUpstreamFailed,
      message: "primary unavailable",
    });
    expect(fallbackSynthesize).not.toHaveBeenCalled();
  });

  it("preserves base-language catalog support when providers are wrapped in failover", () => {
    const primary = {
      ...provider("primary-tts", async () => streamFrom([])),
      configuredModel: "model-en",
      configuredLanguage: "en",
      capabilities: { ...CAPABILITIES, models: ["model-en"], languages: ["en"] },
    } satisfies TextToSpeechProvider;
    const fallback = {
      ...provider("fallback-tts", async () => streamFrom([])),
      configuredModel: "model-en",
      configuredLanguage: "en",
      capabilities: { ...CAPABILITIES, models: ["model-en"], languages: ["en"] },
    } satisfies TextToSpeechProvider;
    const failover = createTtsFailoverProvider({ primary, fallback });

    expect(
      failover.supportsTtsSelection?.(
        { model: "model-en", language: "en-GB" },
        { languageWasCallerSelected: true },
      ),
    ).toBe(true);
  });

  it("preserves regional language matching for catalog-only providers wrapped in failover", () => {
    const primary = {
      ...provider("primary-tts", async () => streamFrom([])),
      capabilities: { ...CAPABILITIES, languages: ["en"] },
    } satisfies TextToSpeechProvider;
    const fallback = {
      ...provider("fallback-tts", async () => streamFrom([])),
      capabilities: { ...CAPABILITIES, languages: ["en"] },
    } satisfies TextToSpeechProvider;
    const failover = createTtsFailoverProvider({ primary, fallback });

    expect(failover.supportsTtsSelection?.({ language: "en-GB" })).toBe(true);
  });

  it("preserves per-call speed when mapped failover settings match a declared variant", async () => {
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
      supportsTtsSpeed: () => true,
    } satisfies TextToSpeechProvider;
    const fallbackRequests: TtsSynthesisRequest[] = [];
    const fallback = {
      ...provider("fallback-tts", async (value) => {
        fallbackRequests.push(value);
        return streamFrom([]);
      }),
      configuredModel: "fallback-model",
      configuredVoice: "fallback-voice",
      supportsTtsSpeed: () => true,
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
    const requestWithSpeed = { ...request(), speed: 1.1 };

    expect(
      failover.supportsTtsSelection?.({
        model: "primary-model",
        voice: "primary-voice",
        speed: 1.1,
      }),
    ).toBe(true);
    await expect(failover.synthesize(requestWithSpeed).then(collect)).resolves.toEqual([]);
    expect(fallbackRequests).toHaveLength(1);
    expect(fallbackRequests[0]).toMatchObject({
      model: "fallback-model",
      voice: "fallback-voice",
      speed: 1.1,
    });
  });

  it("allows a caller language omitted from a declared fallback variant", async () => {
    const primary = {
      ...provider("primary-tts", async () => {
        throw TvicThrowableError.from(
          providerError("provider.upstream_failed", "primary unavailable", {
            provider: "primary-tts",
            retriable: true,
          }),
        );
      }),
      supportsTtsLanguage: () => true,
    } satisfies TextToSpeechProvider;
    const fallbackRequests: TtsSynthesisRequest[] = [];
    const fallback = {
      ...provider("fallback-tts", async (value) => {
        fallbackRequests.push(value);
        return streamFrom([]);
      }),
      capabilities: { ...CAPABILITIES, models: ["fallback-model"], voices: ["fallback-voice"] },
      configuredModel: "fallback-model",
      configuredVoice: "fallback-voice",
      supportsTtsLanguage: () => true,
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
    const callerRequest = {
      ...request(),
      language: "hi-IN",
      selectionContext: { languageWasCallerSelected: true },
    };

    expect(
      failover.supportsTtsSelection?.(
        { model: "primary-model", voice: "primary-voice", language: "hi-IN" },
        { languageWasCallerSelected: true },
      ),
    ).toBe(true);
    await expect(failover.synthesize(callerRequest).then(collect)).resolves.toEqual([]);
    expect(fallbackRequests).toHaveLength(1);
    expect(fallbackRequests[0]).toMatchObject({
      model: "fallback-model",
      voice: "fallback-voice",
      language: "hi-IN",
    });
  });

  it("treats Sarvam's od-IN/or-IN aliases as the same configured failover language", () => {
    const sarvam = createSarvamTtsHttpStreamProvider({
      apiKey: "sarvam-secret",
      voiceId: "shubh",
      language: "od-IN",
    });
    const other = {
      ...provider("other-tts", async () => streamFrom([])),
      configuredLanguage: "od-IN",
    } satisfies TextToSpeechProvider;

    expect(sarvam.configuredLanguage).toBe("or-IN");
    expect(() => createTtsFailoverProvider({ primary: sarvam, fallback: other })).not.toThrow();
  });

  it("uses a configured fallback language when a mapped model requires one", async () => {
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
      configuredLanguage: "en-IN",
    } satisfies TextToSpeechProvider;
    const fallbackRequests: TtsSynthesisRequest[] = [];
    const fallback = {
      ...provider("fallback-tts", async (value) => {
        fallbackRequests.push(value);
        return streamFrom([]);
      }),
      configuredModel: "fallback-model",
      configuredVoice: "fallback-voice",
      configuredLanguage: "en-IN",
      capabilities: { ...CAPABILITIES, models: ["fallback-model"], voices: ["fallback-voice"] },
      requiresTtsLanguageForModel: (model?: string) => model === "fallback-model",
      supportsTtsLanguage: (language: string) => language === "en-IN",
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
      failover.supportsTtsSelection?.({ model: "primary-model", voice: "primary-voice" }),
    ).toBe(true);
    await expect(failover.synthesize(requestWithoutModelOrVoice()).then(collect)).resolves.toEqual(
      [],
    );
    expect(fallbackRequests).toHaveLength(1);
    expect(fallbackRequests[0]?.language).toBeUndefined();
  });

  it("retains the primary error without notifying when mapped settings are invalid", async () => {
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
    let fallbackCalls = 0;
    let fallbackEvents = 0;
    const fallback = {
      ...provider("fallback-tts", async () => {
        fallbackCalls += 1;
        return streamFrom([]);
      }),
      name: `fallback-${"x".repeat(400)}`,
    } satisfies TextToSpeechProvider;
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      mapFallbackRequest: (value) => ({ ...value, voice: "unsupported-voice" }),
      fallbackRequestVariants: [{ fallback: { voice: "unsupported-voice" } }],
      onFallback: () => {
        fallbackEvents += 1;
      },
    });

    await expect(failover.synthesize(request())).rejects.toMatchObject({
      code: "provider.upstream_failed",
      metadata: {
        fallbackValidationFailure: {
          code: TVIC_ERROR_CODES.providerVoiceUnsupported,
          provider: `fallback-${"x".repeat(119)}`,
        },
      },
    });
    expect(fallbackEvents).toBe(0);
    expect(fallbackCalls).toBe(0);
  });

  it("does not notify onFallback when mapping throws", async () => {
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
    let fallbackCalls = 0;
    const onFallback = vi.fn();
    const failover = createTtsFailoverProvider({
      primary,
      fallback: provider("fallback-tts", async () => {
        fallbackCalls += 1;
        return streamFrom([]);
      }),
      mapFallbackRequest: () => {
        throw new Error("😀".repeat(700));
      },
      onFallback,
    });

    await expect(failover.synthesize(request())).rejects.toMatchObject({
      code: "provider.upstream_failed",
      metadata: {
        fallbackValidationFailure: {
          message: "😀".repeat(512),
        },
      },
    });

    expect(onFallback).not.toHaveBeenCalled();
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

    await expect(failover.synthesize(request())).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerUpstreamFailed,
      message: "primary unavailable",
      metadata: {
        fallbackValidationFailure: {
          message:
            "TTS failover mapping must match a declared fallback request variant; mismatched fallback fields: voice",
        },
      },
    });
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

  it("rejects a configured primary language when the fallback declares none", () => {
    const primary = {
      ...provider("primary-tts", async () => streamFrom([])),
      configuredLanguage: "hi-IN",
      languageWasExplicitlyConfigured: true,
    } satisfies TextToSpeechProvider;
    const fallback = provider("fallback-tts", async () => streamFrom([]));

    expect(() => createTtsFailoverProvider({ primary, fallback })).toThrow(
      /both declare compatible configured languages/u,
    );
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
        await expect(failover.synthesize(elevenLabsRequest(model, voice))).rejects.toMatchObject({
          metadata: { outcomeUnknown: true },
        });
      } else {
        const stream = await failover.synthesize(elevenLabsRequest(model, voice));
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

    const stream = await failover.synthesize(cartesiaRequest("cartesia-voice"));

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

      const stream = await failover.synthesize(cartesiaRequest("cartesia-voice"));

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

  it.each(["websocket", "rest"] as const)(
    "rejects an implicit-language Sarvam V4 %s fallback in preflight and dispatch",
    async (transport) => {
      const primaryError = TvicThrowableError.from(
        providerError("provider.upstream_failed", "primary unavailable", {
          provider: "primary-tts",
          retriable: true,
        }),
      );
      const primary = {
        ...provider("primary-tts", async () => {
          throw primaryError;
        }),
        configuredModel: "primary-model",
        configuredVoice: "primary-voice",
        configuredLanguage: "en-IN",
      } satisfies TextToSpeechProvider;
      const sarvamOptions = {
        apiKey: "sarvam-secret",
        modelId: "bulbul:v4-flash",
        voiceId: "aayan_hi_conversational",
      };
      const fallback =
        transport === "websocket"
          ? createSarvamTtsProvider({
              ...sarvamOptions,
              webSocketFactory: () => {
                throw new Error("fallback transport must not be opened");
              },
            })
          : createSarvamTtsRestProvider({
              ...sarvamOptions,
              fetchImpl: async () => {
                throw new Error("fallback transport must not be called");
              },
            });
      const variants = [
        { fallback: { model: "bulbul:v4-flash", voice: "aayan_hi_conversational" } },
      ];
      const failover = createTtsFailoverProvider({
        primary,
        fallback,
        mapFallbackRequest: (value) => ({
          ...value,
          model: "bulbul:v4-flash",
          voice: "aayan_hi_conversational",
        }),
        fallbackRequestVariants: variants,
      });

      expect(failover.requiresTtsLanguageForModel?.("primary-model")).toBe(true);
      expect(
        failover.supportsTtsSelection?.({ model: "primary-model", voice: "primary-voice" }),
      ).toBe(false);
      await expect(failover.synthesize(requestWithoutModelOrVoice())).rejects.toMatchObject({
        code: "provider.upstream_failed",
        metadata: {
          fallbackValidationFailure: { code: TVIC_ERROR_CODES.ttsLanguageUnsupported },
        },
      });
    },
  );

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
    const stream = await failover.synthesize(
      elevenLabsRequest("eleven_flash_v2_5", "voice-primary"),
    );

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
        failover.synthesize(elevenLabsRequest("eleven_flash_v2_5", "voice-primary")),
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

  it("reports uncloneable metadata as a validation error before provider calls", async () => {
    const primarySynthesize = vi.fn(async () => streamFrom([]));
    const fallbackSynthesize = vi.fn(async () => streamFrom([]));

    await expect(
      createTtsFailoverProvider({
        primary: provider("sarvam-tts", primarySynthesize),
        fallback: provider("fallback-tts", fallbackSynthesize),
      }).synthesize({ ...request(), metadata: { callback: () => undefined } }),
    ).rejects.toMatchObject({ code: "provider.invalid_request", category: "validation" });
    expect(primarySynthesize).not.toHaveBeenCalled();
    expect(fallbackSynthesize).not.toHaveBeenCalled();
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

  it("bounds property visits when estimating omitted JSON event values", async () => {
    const requestValue = request();
    const omittedProperties = Object.fromEntries(
      Array.from({ length: 65_537 }, (_, index) => [`property-${index}`, undefined]),
    );
    const oversizedEvent = Object.assign(alignmentEvent(requestValue, "sarvam-tts"), {
      metadata: omittedProperties,
    }) as TtsAlignmentEvent;
    const primaryError = TvicThrowableError.from(
      providerError("provider.sarvam.tts.error", "socket closed", {
        provider: "sarvam-tts",
      }),
    );
    const primary = provider("sarvam-tts", async () => streamFrom([oversizedEvent], primaryError));
    let fallbackCalls = 0;
    const fallback = provider("elevenlabs", async () => {
      fallbackCalls += 1;
      return streamFrom([]);
    });
    const stream = await createTtsFailoverProvider({ primary, fallback }).synthesize(requestValue);
    const iterator = stream.events[Symbol.asyncIterator]();

    expect((await iterator.next()).value).toMatchObject({
      type: "tts.alignment",
      provider: "sarvam-tts",
    });
    await expect(iterator.next()).rejects.toBe(primaryError);
    expect(fallbackCalls).toBe(0);
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

  it("does not notify onFallback when cancellation occurs during mapping", async () => {
    const controller = new AbortController();
    const primary = provider("primary-tts", async () => {
      throw TvicThrowableError.from(
        providerError("provider.upstream_failed", "primary unavailable", {
          provider: "primary-tts",
        }),
      );
    });
    const onFallback = vi.fn();
    let fallbackCalls = 0;
    const fallback = provider("fallback-tts", async () => {
      fallbackCalls += 1;
      return streamFrom([]);
    });
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      mapFallbackRequest: (value) => {
        controller.abort();
        return value;
      },
      onFallback,
    });

    await expect(
      failover.synthesize({ ...request(), signal: controller.signal }),
    ).rejects.toMatchObject({
      code: "provider.connection_cancelled",
    });
    expect(onFallback).not.toHaveBeenCalled();
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
    ).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerUpstreamFailed,
      message: "primary is unavailable",
      metadata: {
        fallbackValidationFailure: { code: TVIC_ERROR_CODES.providerModelUnsupported },
      },
    });
    expect(fallbackCalls).toBe(0);
  });

  it("rejects a fallback model without its required voice during preflight and dispatch", async () => {
    const primary = {
      ...provider("primary-tts", async () => {
        throw TvicThrowableError.from(
          providerError("provider.upstream_failed", "primary is unavailable", {
            provider: "primary-tts",
          }),
        );
      }),
      configuredModel: "primary-model",
    } satisfies TextToSpeechProvider;
    let fallbackCalls = 0;
    const fallback = {
      ...provider("fallback-tts", async () => {
        fallbackCalls += 1;
        return streamFrom([]);
      }),
      configuredModel: "fallback-model",
      capabilities: { ...CAPABILITIES, models: ["fallback-model"], voices: [] },
      requiresTtsVoiceForModel: (model?: string) => model === "fallback-model",
    } satisfies TextToSpeechProvider;
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      mapFallbackRequest: (value) => ({ ...value, model: "fallback-model" }),
      fallbackRequestVariants: [{ fallback: { model: "fallback-model" } }],
    });

    expect(failover.requiresTtsVoiceForModel?.("primary-model")).toBe(true);
    expect(failover.supportsTtsSelection?.({ model: "primary-model" })).toBe(false);
    await expect(failover.synthesize(requestWithoutModelOrVoice())).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerUpstreamFailed,
      metadata: {
        fallbackValidationFailure: { code: TVIC_ERROR_CODES.providerVoiceUnsupported },
      },
    });
    expect(fallbackCalls).toBe(0);
  });

  it("validates a mapper's changed selection against fallback catalogs", async () => {
    const fallbackRequests: TtsSynthesisRequest[] = [];
    const primary = {
      ...provider("primary-tts", async () => {
        throw TvicThrowableError.from(
          providerError("provider.upstream_failed", "primary unavailable", {
            provider: "primary-tts",
          }),
        );
      }),
      capabilities: {
        ...CAPABILITIES,
        models: ["primary-model", "secondary-model"],
        voices: ["primary-voice"],
      },
      configuredModel: "primary-model",
      configuredVoice: "primary-voice",
    } satisfies TextToSpeechProvider;
    let fallbackCalls = 0;
    const fallback = {
      ...provider("fallback-tts", async (value) => {
        fallbackCalls += 1;
        fallbackRequests.push(value);
        return streamFrom([]);
      }),
      capabilities: { ...CAPABILITIES, models: ["fallback-model"], voices: ["fallback-voice"] },
      configuredModel: "fallback-model",
      configuredVoice: "fallback-voice",
    } satisfies TextToSpeechProvider;
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      mapFallbackRequest: (value) => ({
        ...value,
        model: "fallback-model",
        voice: "fallback-voice",
      }),
    });

    expect(failover.capabilities.models).toEqual(["primary-model", "secondary-model"]);
    expect(failover.supportsVoice?.("primary-voice", "primary-model")).toBe(true);
    await collect(
      await failover.synthesize({
        ...request(),
        model: "primary-model",
        voice: "primary-voice",
      }),
    );
    expect(fallbackCalls).toBe(1);
    expect(fallbackRequests[0]).toMatchObject({ model: "fallback-model", voice: "fallback-voice" });

    await collect(
      await failover.synthesize({ ...request(), model: "secondary-model", voice: "primary-voice" }),
    );
    expect(fallbackCalls).toBe(2);
  });

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

  it("defers account-backed voice checks to snapshots while retaining static fallback checks", () => {
    const primary = {
      ...provider("account-primary", async () => streamFrom([])),
      configuredVoice: "default-account-voice",
      capabilities: { ...CAPABILITIES, voiceSelection: "account_snapshot" },
    } satisfies TextToSpeechProvider;
    const fallback = {
      ...provider("catalog-fallback", async () => streamFrom([])),
      supportsVoice: (voice: string) => voice === "custom-account-voice",
    } satisfies TextToSpeechProvider;

    const failover = createTtsFailoverProvider({ primary, fallback });

    expect(failover.capabilities).toMatchObject({
      voiceSelection: "account_snapshot",
      voiceSnapshotProviders: ["account-primary"],
    });
    expect(failover.supportsVoice?.("custom-account-voice")).toBe(true);
    expect(failover.supportsVoice?.("unsupported-voice")).toBe(false);
  });

  it("rejects snapshot calls before the primary when an account-backed fallback has no variants", async () => {
    let primaryCalls = 0;
    const primary = provider("catalog-primary", async (value) => {
      primaryCalls += 1;
      return streamFrom([audioEvent(value)]);
    });
    const fallback = {
      ...provider("account-fallback", async () => streamFrom([])),
      capabilities: { ...CAPABILITIES, voiceSelection: "account_snapshot" },
    } satisfies TextToSpeechProvider;
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      mapFallbackRequest: (value) => ({ ...value, voice: "fallback-account-voice" }),
    });

    await expect(
      failover.synthesize({
        ...request(),
        providerCapabilitySnapshots: [cartesiaCapabilitySnapshot("fallback-account-voice")],
      }),
    ).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerInvalidRequest,
      category: "validation",
      metadata: { snapshotsRequired: true },
    });
    expect(primaryCalls).toBe(0);

    await collect(await failover.synthesize(request()));
    expect(primaryCalls).toBe(1);
  });

  it("rejects a declared Cartesia fallback with an incompatible configured language", () => {
    const primary = createCartesiaTtsProvider({
      apiKey: "test",
      voiceId: "primary_voice",
      modelId: "sonic-3.6",
      locale: "or-IN",
    });
    const fallback = createCartesiaTtsProvider({
      apiKey: "test",
      voiceId: "fallback_voice",
      modelId: "sonic-3.6",
      locale: "or-IN",
    });
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      mapFallbackRequest: (value) => ({
        ...value,
        model: "sonic-3.5",
        voice: "fallback_voice",
      }),
      fallbackRequestVariants: [
        {
          when: { model: "sonic-3.6", voice: "primary_voice" },
          fallback: { model: "sonic-3.5", voice: "fallback_voice" },
        },
      ],
    });

    expect(failover.supportsTtsSelection?.({ model: "sonic-3.6", voice: "primary_voice" })).toBe(
      false,
    );
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
    let checkedPrimaryVoice: string | undefined;
    const primary = {
      ...provider("sarvam-tts", async () => streamFrom([])),
      configuredModel: "bulbul:v4-flash",
      configuredVoice: "kangkana_as_conversational",
      supportsTtsLanguage: (language: string, model?: string, voice?: string) => {
        checkedPrimaryVoice = voice;
        return (
          model === "bulbul:v4-flash" &&
          language === "as-IN" &&
          voice === "kangkana_as_conversational"
        );
      },
      supportsVoice: (voice: string, model?: string) =>
        model === "bulbul:v4-flash" && voice === "kangkana_as_conversational",
    } satisfies TextToSpeechProvider;
    const fallback = {
      ...provider("elevenlabs", async () => streamFrom([])),
      capabilities: { ...CAPABILITIES, languages: ["as-IN"] },
      supportsLanguage: (language: string) => language === "as-IN",
      supportsVoice: (voice: string) => voice === "primary-voice",
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
    expect(
      failover.supportsTtsLanguage?.("as-IN", "bulbul:v4-flash", "kangkana_as_conversational"),
    ).toBe(true);
    expect(checkedPrimaryVoice).toBe("kangkana_as_conversational");
    expect(failover.supportsVoice?.("kangkana_as_conversational", "bulbul:v4-flash")).toBe(true);
    expect(failover.supportsTtsLanguage?.("as-IN", "bulbul:v3")).toBe(false);
  });

  it("checks fallback language support against the mapped fallback model and voice", () => {
    let checkedFallbackSelection:
      | { model: string | undefined; voice: string | undefined }
      | undefined;
    const primary = {
      ...provider("sarvam-tts", async () => streamFrom([])),
      configuredModel: "bulbul:v3",
      configuredVoice: "shubh",
      configuredLanguage: "en-IN",
      supportsLanguage: (language: string, model?: string) =>
        language === "en-IN" && model === "bulbul:v3",
      supportsVoice: (voice: string, model?: string) => voice === "shubh" && model === "bulbul:v3",
    } satisfies TextToSpeechProvider;
    const fallback = {
      ...provider("elevenlabs", async () => streamFrom([])),
      capabilities: {
        ...CAPABILITIES,
        models: ["eleven_flash_v2_5"],
        voices: ["voice-en"],
      },
      configuredModel: "eleven_default",
      configuredVoice: "voice-default",
      configuredLanguage: "en",
      supportsTtsLanguage: (language: string, model?: string, voice?: string) => {
        checkedFallbackSelection = { model, voice };
        return language === "en" && model === "eleven_flash_v2_5" && voice === "voice-en";
      },
    } satisfies TextToSpeechProvider;
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      languageMatch: "base-language",
      fallbackRequestVariants: [
        {
          when: { model: "bulbul:v3", voice: "shubh" },
          fallback: { model: "eleven_flash_v2_5", voice: "voice-en", language: "en" },
        },
      ],
    });

    expect(failover.supportsTtsLanguage?.("en-IN", "bulbul:v3", "shubh")).toBe(true);
    expect(supportsLanguage(failover, "en-IN", "bulbul:v3")).toBe(true);
    expect(checkedFallbackSelection).toEqual({
      model: "eleven_flash_v2_5",
      voice: "voice-en",
    });
  });

  it("does not let a mapper bypass the fallback's language support at dispatch", async () => {
    const fallbackSynthesize = vi.fn(async () => streamFrom([]));
    const primary = {
      ...provider("primary-tts", async () => {
        throw TvicThrowableError.from(
          providerError("provider.upstream_failed", "primary unavailable", {
            provider: "primary-tts",
          }),
        );
      }),
      configuredLanguage: "en",
      supportsLanguage: (language: string) => language === "hi-IN",
    } satisfies TextToSpeechProvider;
    const fallback = {
      ...provider("fallback-tts", fallbackSynthesize),
      configuredLanguage: "en",
      supportsLanguage: (language: string) => language === "en",
    } satisfies TextToSpeechProvider;
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      mapFallbackRequest: (value) => value,
    });

    // A mapper's output is only known at synthesis time, so preflight checks the primary.
    expect(failover.supportsTtsLanguage?.("hi-IN", "primary-model", "primary-voice")).toBe(true);
    expect(failover.supportsTtsLanguage?.("en", "primary-model", "primary-voice")).toBe(false);
    await expect(failover.synthesize({ ...request(), language: "hi-IN" })).rejects.toMatchObject({
      code: "provider.upstream_failed",
      provider: "primary-tts",
      metadata: { fallbackValidationFailure: { category: "validation", provider: "fallback-tts" } },
    });
    expect(fallbackSynthesize).not.toHaveBeenCalled();
  });

  it("checks declared per-call voice support on the primary and mapped fallback", () => {
    const primary = {
      ...provider("primary", async () => streamFrom([])),
      supportsVoice: () => true,
      supportsTtsVoiceOverride: (voice: string) => voice === "primary-voice",
    } satisfies TextToSpeechProvider;
    const fallback = {
      ...provider("fallback", async () => streamFrom([])),
      supportsVoice: () => true,
      supportsTtsVoiceOverride: (voice: string) => voice === "fallback-voice",
    } satisfies TextToSpeechProvider;
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      mapFallbackRequest: (value) => ({ ...value, voice: "fallback-voice" }),
      fallbackRequestVariants: [{ fallback: { voice: "fallback-voice" } }],
    });

    expect(failover.supportsTtsVoiceOverride?.("primary-voice", "primary-model")).toBe(true);
    expect(failover.supportsTtsVoiceOverride?.("unlisted-voice", "primary-model")).toBe(false);
  });

  it("checks language-conditioned fallback variants with the selected language", () => {
    const primary = {
      ...provider("primary", async () => streamFrom([])),
      supportsTtsVoiceOverride: (voice: string) => voice === "primary-voice",
    } satisfies TextToSpeechProvider;
    const fallback = {
      ...provider("fallback", async () => streamFrom([])),
      supportsTtsVoiceOverride: (voice: string) => voice === "fallback-voice",
    } satisfies TextToSpeechProvider;
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      mapFallbackRequest: (value) => ({ ...value, voice: "fallback-voice" }),
      fallbackRequestVariants: [
        { when: { language: "hi-IN" }, fallback: { voice: "fallback-voice" } },
      ],
    });
    expect(failover.supportsTtsVoiceOverride?.("primary-voice", "primary-model", "hi-IN")).toBe(
      true,
    );
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
    let fallbackEvents = 0;
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      mapFallbackRequest: (value) => ({ ...value, sessionId: "wrong-session" as never }),
      fallbackRequestVariants: [{ fallback: {} }],
      onFallback: () => {
        fallbackEvents += 1;
      },
    });

    await expect(failover.synthesize(request())).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerUpstreamFailed,
      metadata: {
        fallbackValidationFailure: {
          message:
            "TTS failover request mapping may change only provider-specific fields such as model or voice",
        },
      },
    });
    expect(fallbackEvents).toBe(0);
  });

  it("preserves getter-backed prototype fields returned by a fallback mapper", async () => {
    const primary = provider("primary-tts", async () => {
      throw TvicThrowableError.from(
        providerError("provider.upstream_failed", "unavailable", { provider: "primary-tts" }),
      );
    });
    const fallbackRequests: TtsSynthesisRequest[] = [];
    const fallback = {
      ...provider("fallback-tts", async (value) => {
        fallbackRequests.push(value);
        return streamFrom([]);
      }),
      capabilities: {
        ...CAPABILITIES,
        models: ["fallback-model"],
        voices: ["fallback-voice"],
      },
    } satisfies TextToSpeechProvider;
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      mapFallbackRequest: (value) => {
        const values = { ...value, model: "fallback-model", voice: "fallback-voice" };
        const prototype = Object.defineProperties(
          {},
          Object.fromEntries(
            Object.keys(values).map((key) => [
              key,
              { get: () => values[key as keyof typeof values] },
            ]),
          ),
        );
        return Object.create(prototype) as TtsSynthesisRequest;
      },
    });

    await expect(failover.synthesize(request()).then(collect)).resolves.toEqual([]);
    expect(fallbackRequests).toHaveLength(1);
    expect(fallbackRequests[0]).toMatchObject({
      model: "fallback-model",
      voice: "fallback-voice",
      text: request().text,
      format: PCM16_16K_MONO,
    });
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

    await expect(failover.synthesize(requestValue)).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerUpstreamFailed,
      metadata: {
        fallbackValidationFailure: {
          message:
            "TTS failover request mapping may change only provider-specific fields such as model or voice",
        },
      },
    });
    expect(fallbackCalls).toBe(0);
  });

  it("rejects a mapper that drops caller cancellation", async () => {
    const primary = provider("primary-tts", async () => {
      throw TvicThrowableError.from(
        providerError("provider.upstream_failed", "unavailable", { provider: "primary-tts" }),
      );
    });
    const controller = new AbortController();
    const failover = createTtsFailoverProvider({
      primary,
      fallback: provider("fallback-tts", async () => streamFrom([])),
      mapFallbackRequest: (value) => {
        const { signal: _signal, ...mapped } = value;
        return mapped;
      },
    });

    await expect(
      failover.synthesize({ ...request(), signal: controller.signal }),
    ).rejects.toMatchObject({
      code: "provider.upstream_failed",
      metadata: {
        fallbackValidationFailure: {
          code: TVIC_ERROR_CODES.providerInvalidRequest,
          message:
            "TTS failover request mapping may change only provider-specific fields such as model or voice",
        },
      },
    });
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

    await expect(failover.synthesize(requestValue)).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerUpstreamFailed,
      metadata: {
        fallbackValidationFailure: {
          message:
            "TTS failover request mapping may change only provider-specific fields such as model or voice",
        },
      },
    });
    expect(requestValue.format).toEqual(PCM16_16K_MONO);
    expect(fallbackCalls).toBe(0);
  });

  it("isolates the fallback predicate from the request used for selection", async () => {
    const fallbackRequests: TtsSynthesisRequest[] = [];
    const primary = provider("primary-tts", async () => {
      throw TvicThrowableError.from(
        providerError("provider.upstream_failed", "unavailable", { provider: "primary-tts" }),
      );
    });
    const fallback = {
      ...provider("fallback-tts", async (value) => {
        fallbackRequests.push(value);
        return streamFrom([]);
      }),
      capabilities: { ...CAPABILITIES, voices: ["primary-voice", "other-voice"] },
    };
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      shouldFallback: (_error, value) => {
        (value as { voice: string }).voice = "other-voice";
        return true;
      },
    });

    await collect(await failover.synthesize(request()));

    expect(fallbackRequests[0]?.voice).toBe("primary-voice");
  });

  it("detaches the mapped request before capability checks and provider invocation", async () => {
    const fallbackRequests: TtsSynthesisRequest[] = [];
    const primary = provider("primary-tts", async () => {
      throw TvicThrowableError.from(
        providerError("provider.upstream_failed", "unavailable", { provider: "primary-tts" }),
      );
    });
    const fallback = {
      ...provider("fallback-tts", async (value) => {
        fallbackRequests.push(value);
        return streamFrom([]);
      }),
      capabilities: { ...CAPABILITIES, voices: ["fallback-voice"] },
    };
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      fallbackRequestVariants: [
        {
          when: { model: "primary-model", voice: "primary-voice" },
          fallback: { model: "primary-model", voice: "fallback-voice" },
        },
      ],
      mapFallbackRequest: (value) => {
        const mapped = { ...value, voice: "fallback-voice" };
        queueMicrotask(() => {
          (mapped as { voice: string }).voice = "unmapped-voice";
        });
        return mapped;
      },
    });

    await collect(await failover.synthesize(request()));

    expect(fallbackRequests[0]?.voice).toBe("fallback-voice");
  });

  it("does not let the fallback observer mutate the validated provider request", async () => {
    const capabilitySnapshot = createProviderCapabilitySnapshot({
      provider: "fallback-tts",
      source: "https://provider.example/models",
      fetchedAt: "2026-10-25T00:00:00.000Z",
      validUntil: "2026-10-26T00:00:00.000Z",
      facts: [
        {
          feature: "tts.model.available",
          scope: "model",
          model: "primary-model",
          status: "supported",
        },
      ],
    });
    const received: TtsSynthesisRequest[] = [];
    const primary = provider("primary-tts", async () => {
      throw TvicThrowableError.from(
        providerError("provider.upstream_failed", "unavailable", { provider: "primary-tts" }),
      );
    });
    const fallback = provider("fallback-tts", async (value) => {
      received.push(value);
      return streamFrom([]);
    });
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      onFallback: ({ fallbackRequest }) => {
        (fallbackRequest.format as unknown as { sampleRateHz: number }).sampleRateHz = 8_000;
        const fact = fallbackRequest.providerCapabilitySnapshots?.[0]?.facts[0];
        if (fact) (fact as { status: string }).status = "unsupported";
      },
    });

    await collect(
      await failover.synthesize({
        ...request(),
        providerCapabilitySnapshots: [capabilitySnapshot],
      }),
    );

    expect(received[0]?.format).toEqual(PCM16_16K_MONO);
    expect(received[0]?.providerCapabilitySnapshots?.[0]?.facts[0]?.status).toBe("supported");
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
      code: TVIC_ERROR_CODES.providerUpstreamFailed,
      metadata: {
        fallbackValidationFailure: { code: TVIC_ERROR_CODES.providerInvalidRequest },
      },
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

    await expect(failover.synthesize(request())).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerUpstreamFailed,
      metadata: {
        fallbackValidationFailure: {
          message:
            "TTS failover request mapping may change only provider-specific fields such as model or voice",
        },
      },
    });
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
      providerCapabilityEvaluationTimeMs: 1_798_000_000_000,
      metadata: { traceId: "trace-1" },
      providerCapabilitySnapshots: [
        {
          provider: "cartesia",
          source: "https://provider.example/capabilities",
          fetchedAt: "2026-10-25T00:00:00.000Z",
          validUntil: "2026-10-26T00:00:00.000Z",
          facts: [],
        },
      ],
    };
    const mappings: Array<(value: TtsSynthesisRequest) => TtsSynthesisRequest> = [
      (value) => ({ ...value, speed: 1.2 }),
      (value) => ({ ...value, timestamps: false }),
      (value) => ({ ...value, providerCapabilityEvaluationTimeMs: 1_798_000_000_001 }),
      (value) => ({ ...value, metadata: { traceId: "trace-2" } }),
      (value) => {
        const { providerCapabilitySnapshots: droppedSnapshots, ...mapped } = value;
        void droppedSnapshots;
        return mapped;
      },
      (value) => {
        const facts = value.providerCapabilitySnapshots?.[0]?.facts as unknown as unknown[];
        facts.push({ feature: "changed", scope: "voice", voice: "voice-a", status: "supported" });
        return value;
      },
    ];

    for (const mapFallbackRequest of mappings) {
      const failover = createTtsFailoverProvider({
        primary,
        fallback,
        mapFallbackRequest,
        fallbackRequestVariants: [{ fallback: {} }],
      });
      await expect(failover.synthesize(original)).rejects.toMatchObject({
        code: TVIC_ERROR_CODES.providerUpstreamFailed,
        metadata: {
          fallbackValidationFailure: {
            message:
              "TTS failover request mapping may change only provider-specific fields such as model or voice",
          },
        },
      });
    }

    expect(fallbackCalls).toBe(0);
    expect(original.providerCapabilitySnapshots?.[0]?.facts).toEqual([]);
  });

  it("rejects oversized capability snapshots before invoking the primary provider", async () => {
    const primarySynthesize = vi.fn(async () => streamFrom([]));
    const primary = provider("primary-tts", primarySynthesize);
    const fallback = provider("fallback-tts", async () => streamFrom([]));
    const value = "x".repeat(256);
    const snapshot = createProviderCapabilitySnapshot({
      provider: "cartesia",
      source: "https://provider.example/capabilities",
      fetchedAt: "2026-10-25T00:00:00.000Z",
      validUntil: "2026-10-26T00:00:00.000Z",
      facts: Array.from({ length: 257 }, (_, index) => ({
        feature: `feature-${index}`,
        scope: "provider",
        status: "supported",
        value: Array.from({ length: 64 }, () => value),
      })),
    });
    const failover = createTtsFailoverProvider({ primary, fallback });

    await expect(
      failover.synthesize({ ...request(), providerCapabilitySnapshots: [snapshot] }),
    ).rejects.toThrow(/4194304 bytes of text/);
    expect(primarySynthesize).not.toHaveBeenCalled();
  });

  it("rejects uncloneable metadata before a mapper can mutate caller-owned objects", async () => {
    const primarySynthesize = vi.fn(async () => {
      throw TvicThrowableError.from(
        providerError("provider.upstream_failed", "primary unavailable", {
          provider: "primary-tts",
          retriable: true,
        }),
      );
    });
    const primary = provider("primary-tts", primarySynthesize);
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

    await expect(failover.synthesize(requestValue)).rejects.toMatchObject({
      code: "provider.invalid_request",
      category: "validation",
      message: expect.stringMatching(/structured-cloneable/u),
    });
    expect(date.getTime()).toBe(0);
    expect(primarySynthesize).not.toHaveBeenCalled();
    expect(mapperCalls).toBe(0);
    expect(fallbackCalls).toBe(0);
  });

  it.each(["default", "custom predicate"] as const)(
    "rejects uncloneable metadata before %s failover handling",
    async (fallbackMode) => {
      const primarySynthesize = vi.fn(async () => streamFrom([]));
      const fallbackSynthesize = vi.fn(async () => streamFrom([]));
      const failover = createTtsFailoverProvider({
        primary: provider("primary-tts", primarySynthesize),
        fallback: provider("fallback-tts", fallbackSynthesize),
        ...(fallbackMode === "custom predicate" ? { shouldFallback: () => true } : {}),
      });

      await expect(
        failover.synthesize({ ...request(), metadata: { callback: () => undefined } }),
      ).rejects.toMatchObject({ code: "provider.invalid_request", category: "validation" });
      expect(primarySynthesize).not.toHaveBeenCalled();
      expect(fallbackSynthesize).not.toHaveBeenCalled();
    },
  );

  it("passes cloned plain metadata to a fallback predicate", async () => {
    class RequestMetadata {
      readonly label = "request-metadata";
    }
    const metadata = new RequestMetadata();
    let predicateMetadata: Readonly<Record<string, unknown>> | undefined;
    const primary = provider("primary-tts", async () => {
      throw TvicThrowableError.from(
        providerError("provider.upstream_failed", "primary unavailable", {
          provider: "primary-tts",
          retriable: true,
        }),
      );
    });
    const fallback = provider("fallback-tts", async () => streamFrom([]));
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      shouldFallback: (_error, value) => {
        predicateMetadata = value.metadata;
        return true;
      },
    });

    await collect(
      await failover.synthesize({
        ...request(),
        metadata: metadata as unknown as Readonly<Record<string, unknown>>,
      }),
    );
    expect(predicateMetadata).not.toBe(metadata);
    expect(Object.getPrototypeOf(predicateMetadata)).toBe(Object.prototype);
    expect(predicateMetadata).toEqual({ label: "request-metadata" });
  });
});
