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
  createSarvamTtsRestProvider,
  createSarvamTtsHttpStreamProvider,
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

    for (const providerValue of providers) {
      const ranges = providerValue.capabilities.ttsSpeedRanges;
      expect(ranges?.length).toBeGreaterThan(0);
      for (const range of ranges ?? []) {
        expect(
          evaluateProviderCompatibility(providerValue, {
            kind: "tts",
            model: range.model,
            ttsSpeed: range.min,
          }).compatible,
        ).toBe(true);
        expect(
          evaluateProviderCompatibility(providerValue, {
            kind: "tts",
            model: range.model,
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

    expect(createTtsFailoverProvider({ primary, fallback }).requiredTtsVoiceCapabilities).toEqual([
      { ...voiceRequirement, voiceSource: "requested" },
      { ...voiceRequirement, voiceSource: "mapped" },
    ]);
  });

  it("requires declared model and voice mappings for account-backed fallbacks", () => {
    const fallback = {
      ...provider("account-fallback", async () => streamFrom([])),
      capabilities: { ...CAPABILITIES, voiceSelection: "account_snapshot" as const },
    };

    expect(() =>
      createTtsFailoverProvider({
        primary: provider("primary-tts", async () => streamFrom([])),
        fallback,
        mapFallbackRequest: (value) => ({
          ...value,
          model: "fallback-model",
          voice: "fallback-voice",
        }),
      }),
    ).toThrow(/declare fallback voice mappings/);
  });

  it("requires a declared voice mapping when a custom mapper can change a required fallback voice", () => {
    const fallback = {
      ...provider("fallback-tts", async () => streamFrom([])),
      capabilities: { ...CAPABILITIES, voices: ["fallback-voice"] },
      requiredTtsVoiceCapabilities: [
        {
          provider: "fallback-tts",
          feature: "tts.voice.isPro",
          expectedBooleanValue: false,
        },
      ],
    };

    expect(() =>
      createTtsFailoverProvider({
        primary: provider("primary-tts", async () => streamFrom([])),
        fallback,
        mapFallbackRequest: (value) => ({ ...value, voice: "fallback-voice" }),
      }),
    ).toThrow(/voice-scoped fallback requirements.*declare fallback voice mappings/u);
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
      fallbackVoiceMappings: [
        {
          requestedModel: "primary-model",
          requestedVoice: "primary-voice",
          model: "fallback-model",
          voice: "fallback-voice",
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
      fallbackVoiceMappings: [{ voice: "fallback-voice" }],
    });

    await collect(await failover.synthesize(request()));

    expect(fallbackRequests[0]).toMatchObject({
      model: "primary-model",
      voice: "fallback-voice",
    });
  });

  it("keeps request model usage attribution when a fallback mapping changes only voice", () => {
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
      fallbackVoiceMappings: [{ voice: "fallback-voice" }],
    });

    expect(failover.usageAccounting).toEqual({
      reportsTextCharacters: true,
      usesRequestModelForUsage: true,
    });
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
      fallbackVoiceMappings: [
        { requestedModel: "primary-model", model: "fallback-model", voice: "fallback-voice" },
      ],
    });

    expect(failover.usageAccounting).toEqual({ reportsTextCharacters: true });
  });

  it("rejects an oversized fallback mapping list before reading its entries", () => {
    const mappings = new Proxy(
      Array.from({ length: 65 }, () => ({ voice: "fallback-voice" })),
      {
        get(target, property, receiver) {
          if (property === "0") throw new Error("mapping entry read before limit check");
          return Reflect.get(target, property, receiver);
        },
      },
    );

    expect(() =>
      createTtsFailoverProvider({
        primary: provider("primary-tts", async () => streamFrom([])),
        fallback: provider("fallback-tts", async () => streamFrom([])),
        fallbackVoiceMappings: mappings,
      }),
    ).toThrow(/at most 64 entries/);
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
      fallbackVoiceMappings: [
        {
          requestedModel: "primary-model",
          requestedVoice: "primary-voice",
          model: "fallback-model",
          voice: "fallback-voice",
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
      fallbackVoiceMappings: [
        {
          requestedModel: "primary-model",
          requestedVoice: "primary-voice",
          model: "fallback-model",
          voice: "declared-fallback-voice",
        },
      ],
      mapFallbackRequest: (value) => ({
        ...value,
        model: "fallback-model",
        voice: "undeclared-fallback-voice",
      }),
    });

    await expect(failover.synthesize(request())).rejects.toThrow(
      "TTS failover request does not match its declared fallback voice mapping",
    );
    expect(fallbackCalls).toBe(0);
  });

  it("rejects typed text controls before a primary that cannot preserve them runs", async () => {
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
    ).rejects.toMatchObject({ category: "validation" });
    expect(primarySynthesize).not.toHaveBeenCalled();
    expect(fallbackSynthesize).not.toHaveBeenCalled();
  });

  it("preserves only text controls supported by both failover providers", async () => {
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
      { model: "primary-model", controls: ["spell"] },
    ]);
    await expect(
      failover.synthesize({
        ...request(),
        textControls: [{ type: "spell", match: "TVIC" }],
      }),
    ).resolves.toBeDefined();
    expect(primarySynthesize).toHaveBeenCalledOnce();
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
      fallbackVoiceMappings: [
        {
          requestedModel: "primary-model",
          requestedVoice: "primary-voice",
          model: "eleven_flash_v2_5",
          voice: "eleven-voice",
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

  it("preserves a non-fallback provider error when request metadata is not cloneable", async () => {
    const primaryError = TvicThrowableError.from(
      providerError("provider.sarvam.tts.error", "permanent provider failure", {
        provider: "sarvam-tts",
        retriable: false,
      }),
    );
    let fallbackCalls = 0;
    const primary = provider("sarvam-tts", async () => {
      throw primaryError;
    });
    const fallback = provider("fallback-tts", async () => {
      fallbackCalls += 1;
      return streamFrom([]);
    });

    await expect(
      createTtsFailoverProvider({ primary, fallback }).synthesize({
        ...request(),
        metadata: { callback: () => undefined },
      }),
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
      mapFallbackRequest: (value) => ({ ...value }),
    });

    await expect(
      failover.synthesize({ ...request(), model: "bulbul:v4-flash", voice: "simran_en_customer" }),
    ).rejects.toMatchObject({ code: TVIC_ERROR_CODES.providerModelUnsupported });
    expect(fallbackCalls).toBe(0);
  });

  it("requires a declared fallback mapping before advertising or using a changed selection", async () => {
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
    const fallback = {
      ...provider("fallback-tts", async () => {
        fallbackCalls += 1;
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

    expect(failover.capabilities.models).toEqual([]);
    expect(failover.supportsVoice?.("primary-voice", "primary-model")).toBe(false);
    await expect(
      failover.synthesize({
        ...request(),
        model: "primary-model",
        voice: "primary-voice",
      }),
    ).rejects.toThrow(
      "TTS failover request mapping may change model or voice only with a declared fallback voice mapping",
    );
    expect(fallbackCalls).toBe(0);
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
      supportsLanguage: (language: string, model?: string, voice?: string) => {
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
      supportsVoice: (voice: string) => voice === "kangkana_as_conversational",
    } satisfies TextToSpeechProvider;

    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      mapFallbackRequest: (value) => ({
        ...value,
        model: "primary-model",
        voice: "primary-voice",
      }),
    });

    expect(failover.configuredModel).toBe("bulbul:v4-flash");
    expect(failover.configuredVoice).toBe("kangkana_as_conversational");
    expect(
      failover.supportsLanguage?.("as-IN", "bulbul:v4-flash", "kangkana_as_conversational"),
    ).toBe(true);
    expect(checkedPrimaryVoice).toBe("kangkana_as_conversational");
    expect(failover.supportsVoice?.("kangkana_as_conversational", "bulbul:v4-flash")).toBe(true);
    expect(failover.supportsLanguage?.("as-IN", "bulbul:v3")).toBe(false);
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
      supportsLanguage: (language: string, model?: string, voice?: string) => {
        checkedFallbackSelection = { model, voice };
        return language === "en" && model === "eleven_flash_v2_5" && voice === "voice-en";
      },
    } satisfies TextToSpeechProvider;
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      languageMatch: "base-language",
      fallbackVoiceMappings: [
        {
          requestedModel: "bulbul:v3",
          requestedVoice: "shubh",
          model: "eleven_flash_v2_5",
          voice: "voice-en",
        },
      ],
    });

    expect(supportsLanguage(failover, "en-IN", "bulbul:v3", "shubh")).toBe(true);
    expect(checkedFallbackSelection).toEqual({
      model: "eleven_flash_v2_5",
      voice: "voice-en",
    });
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
    });

    await expect(failover.synthesize(requestValue)).rejects.toThrow(
      "TTS failover request mapping may change only provider-specific fields",
    );
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
      fallbackVoiceMappings: [
        {
          requestedModel: "primary-model",
          requestedVoice: "primary-voice",
          model: "primary-model",
          voice: "fallback-voice",
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
      const failover = createTtsFailoverProvider({ primary, fallback, mapFallbackRequest });
      await expect(failover.synthesize(original)).rejects.toThrow(
        "TTS failover request mapping may change only provider-specific fields",
      );
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

  it("preserves a declined fallback error when request metadata is uncloneable", async () => {
    const originalError = TvicThrowableError.from(
      providerError("provider.invalid_request", "primary rejected the request", {
        provider: "primary-tts",
        retriable: false,
      }),
    );
    const primary = provider("primary-tts", async () => {
      throw originalError;
    });
    let fallbackCalls = 0;
    const fallback = provider("fallback-tts", async () => {
      fallbackCalls += 1;
      return streamFrom([]);
    });
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      shouldFallback: () => false,
    });

    await expect(
      failover.synthesize({ ...request(), metadata: { callback: () => undefined } }),
    ).rejects.toBe(originalError);
    expect(fallbackCalls).toBe(0);
  });
});
