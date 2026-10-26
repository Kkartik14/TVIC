import { describe, expect, it } from "vitest";

import {
  PCM16_16K_MONO,
  createProviderTtsVoiceMappings,
  evaluateProviderCompatibility,
  MAX_PROVIDER_TTS_VOICE_MAPPINGS,
  sameAudioFormat,
  type CallHandle,
  type CallId,
  type LlmCompletionRequest,
  type Provider,
  type SessionId,
  type TurnId,
} from "../src/index.js";

const provider = {
  name: "test-tts",
  kind: "tts",
  version: "1.0.0",
  region: "in",
  capabilities: {
    streaming: { input: true, output: true, native: true },
    cancellation: { request: true, output: true, buffer: false, truncation: true },
    transports: ["websocket"],
    audio: { input: [PCM16_16K_MONO], output: [PCM16_16K_MONO] },
    languages: ["en", "hi"],
    models: ["voice-1"],
    voices: ["calm"],
    turnDetection: ["provider", "manual"],
    tools: { functionCalling: true, parallelCalls: false },
    playout: { clearBuffer: false, acknowledgement: false, position: true },
    regions: ["in"],
    dataPolicies: ["zero_retention"],
  },
} as const satisfies Provider;

describe("provider capability negotiation", () => {
  it("normalizes bounded, unique TTS voice mappings", () => {
    const mappings = createProviderTtsVoiceMappings([
      {
        requestedModel: "primary-model",
        requestedVoice: "primary-voice",
        provider: "fallback-tts",
        model: "fallback-model",
        voice: "fallback-voice",
      },
    ]);

    expect(mappings).toEqual([
      {
        requestedModel: "primary-model",
        requestedVoice: "primary-voice",
        provider: "fallback-tts",
        model: "fallback-model",
        voice: "fallback-voice",
      },
    ]);
    expect(Object.isFrozen(mappings)).toBe(true);
    expect(Object.isFrozen(mappings[0])).toBe(true);
    expect(() =>
      createProviderTtsVoiceMappings([
        { requestedVoice: "voice-a", provider: "fallback-a", voice: "target-a" },
        { requestedVoice: "voice-a", provider: "fallback-b", voice: "target-b" },
      ]),
    ).toThrow(/unique request selectors/);
    expect(() =>
      createProviderTtsVoiceMappings(
        Array.from({ length: MAX_PROVIDER_TTS_VOICE_MAPPINGS + 1 }, (_, index) => ({
          requestedVoice: `voice-${index}`,
          provider: "fallback-tts",
          voice: `target-${index}`,
        })),
      ),
    ).toThrow(/at most/);
  });

  it("keeps text delivery optional on call handles", () => {
    const handle = {
      callId: "call_optional_text" as CallId,
      events: { async *[Symbol.asyncIterator]() {} },
      async send() {
        return true;
      },
      async clear() {},
      async close() {},
    } satisfies CallHandle;

    expect(handle.callId).toBe("call_optional_text");
  });

  it("keeps the LLM safety identifier optional", () => {
    const request = {
      sessionId: "session_provider" as SessionId,
      turnId: "turn_provider" as TurnId,
      model: "test-model",
      messages: [],
      stream: true,
    } satisfies LlmCompletionRequest;

    expect("safetyIdentifier" in request).toBe(false);
  });

  it("accepts a provider only when all hard requirements are met", () => {
    expect(
      evaluateProviderCompatibility(provider, {
        kind: "tts",
        streaming: { input: true, output: true, native: true },
        cancellation: { request: true, truncation: true },
        transport: "websocket",
        inputFormat: PCM16_16K_MONO,
        outputFormat: PCM16_16K_MONO,
        language: "hi",
        model: "voice-1",
        voice: "calm",
        turnDetection: "provider",
        functionCalling: true,
        playout: { position: true },
        region: "in",
        dataPolicy: "zero_retention",
      }),
    ).toEqual({ compatible: true, issues: [] });
  });

  it("returns every incompatibility with a stable code and requirement path", () => {
    const result = evaluateProviderCompatibility(provider, {
      kind: "stt",
      streaming: { output: true },
      cancellation: { buffer: true },
      transport: "http",
      outputFormat: { encoding: "pcm_s16le", sampleRateHz: 24000, channels: 1 },
      language: "fr",
      model: "voice-2",
      voice: "bright",
      turnDetection: "semantic",
      parallelToolCalls: true,
      playout: { acknowledgement: true },
      callControl: ["outbound"],
      region: "eu",
      dataPolicy: "no_training",
    });

    expect(result.compatible).toBe(false);
    expect(result.issues.map(({ code, requirement }) => `${code}:${requirement}`).sort()).toEqual(
      [
        "audio.output_unsupported:outputFormat",
        "call_control.unsupported:callControl.outbound",
        "cancellation.unsupported:cancellation.buffer",
        "data_policy.unsupported:data_policy",
        "kind.unsupported:kind",
        "language.unsupported:language",
        "provider.model_unsupported:model",
        "playout.unsupported:playout.acknowledgement",
        "region.unsupported:region",
        "tools.unsupported:parallelToolCalls",
        "transport.unsupported:transport",
        "turn_detection.unsupported:turn_detection",
        "provider.voice_unsupported:voice",
      ].sort(),
    );
  });

  it("does not require omitted optional capabilities", () => {
    expect(
      evaluateProviderCompatibility(provider, {
        kind: "tts",
        functionCalling: false,
        parallelToolCalls: false,
      }),
    ).toEqual({ compatible: true, issues: [] });
  });

  it("requires a model to declare the requested TTS speed range", () => {
    const speedProvider = {
      ...provider,
      capabilities: {
        ...provider.capabilities,
        models: ["eleven_multilingual_v2", "another-model"],
        ttsSpeedRanges: [{ model: "eleven_multilingual_v2", min: 0.7, max: 1.2 }],
      },
    } satisfies Provider;

    expect(
      evaluateProviderCompatibility(speedProvider, {
        kind: "tts",
        model: "eleven_multilingual_v2",
        ttsSpeed: 1.2,
      }),
    ).toEqual({ compatible: true, issues: [] });
    expect(
      evaluateProviderCompatibility(speedProvider, {
        kind: "tts",
        model: "eleven_multilingual_v2",
        ttsSpeed: 1.21,
      }),
    ).toMatchObject({
      compatible: false,
      issues: [{ code: "tts_speed.unsupported", requirement: "ttsSpeed" }],
    });
    expect(
      evaluateProviderCompatibility(speedProvider, {
        kind: "tts",
        model: "another-model",
        ttsSpeed: 1,
      }),
    ).toMatchObject({
      compatible: false,
      issues: [{ code: "tts_speed.unsupported", requirement: "ttsSpeed" }],
    });
  });

  it("lets an adapter validate a dynamic voice catalog when no static list is declared", () => {
    const { voices: _voices, ...capabilitiesWithoutVoiceList } = provider.capabilities;
    const dynamicVoiceProvider = {
      ...provider,
      capabilities: { ...capabilitiesWithoutVoiceList, models: ["dynamic-model"] },
      supportsVoice: (voice: string, model?: string) =>
        model === "dynamic-model" && voice === "adapter-owned-voice",
    } satisfies Provider;

    expect(
      evaluateProviderCompatibility(dynamicVoiceProvider, {
        kind: "tts",
        model: "dynamic-model",
        voice: "adapter-owned-voice",
      }),
    ).toEqual({ compatible: true, issues: [] });
  });

  it("lets an adapter validate a model-specific language outside its stable catalog", () => {
    const modelSpecificLanguageProvider = {
      ...provider,
      capabilities: { ...provider.capabilities, languages: ["en"], models: ["dynamic-model"] },
      supportsLanguage: (language: string, model?: string) =>
        model === "dynamic-model" && language === "beta-language",
    } satisfies Provider;

    expect(
      evaluateProviderCompatibility(modelSpecificLanguageProvider, {
        kind: "tts",
        model: "dynamic-model",
        language: "beta-language",
      }),
    ).toEqual({ compatible: true, issues: [] });
  });

  it("passes the selected voice to adapter language compatibility", () => {
    let selectedVoice: string | undefined;
    const voiceSpecificLanguageProvider = {
      ...provider,
      capabilities: {
        ...provider.capabilities,
        models: ["dynamic-model"],
        voices: ["voice-en"],
      },
      supportsLanguage: (_language: string, _model?: string, voice?: string) => {
        selectedVoice = voice;
        return voice === "voice-en";
      },
    } satisfies Provider;

    expect(
      evaluateProviderCompatibility(voiceSpecificLanguageProvider, {
        kind: "tts",
        model: "dynamic-model",
        language: "en",
        voice: "voice-en",
      }),
    ).toEqual({ compatible: true, issues: [] });
    expect(selectedVoice).toBe("voice-en");
  });

  it("treats an adapter callback as authoritative over a static catalog", () => {
    const providerWithRejectedLanguage = {
      ...provider,
      supportsLanguage: () => false,
    } satisfies Provider;

    expect(
      evaluateProviderCompatibility(providerWithRejectedLanguage, {
        kind: "tts",
        language: "en",
      }),
    ).toMatchObject({
      compatible: false,
      issues: [{ code: "language.unsupported", requirement: "language" }],
    });
  });

  it("reports missing complete-input capability when a batch requirement is explicit", () => {
    expect(
      evaluateProviderCompatibility(provider, {
        kind: "stt",
        batch: { input: true, output: true },
        batchModel: "ink-whisper",
      }),
    ).toMatchObject({
      compatible: false,
      issues: [
        {
          code: "kind.unsupported",
          requirement: "kind",
        },
        {
          code: "batch.unsupported",
          requirement: "batch.input",
        },
        {
          code: "batch.unsupported",
          requirement: "batch.output",
        },
        {
          code: "provider.model_unsupported",
          requirement: "batch_model",
        },
      ],
    });
  });

  it("accepts a declared batch model when the batch capability is present", () => {
    const batchProvider = {
      ...provider,
      kind: "stt",
      capabilities: {
        ...provider.capabilities,
        batch: { input: true, output: true },
        batchModels: ["ink-whisper"],
      },
    } satisfies Provider;

    expect(
      evaluateProviderCompatibility(batchProvider, {
        kind: "stt",
        batch: { input: true, output: true },
        batchModel: "ink-whisper",
      }),
    ).toEqual({ compatible: true, issues: [] });
  });

  it("compares normalized audio formats by encoding, rate, and channels", () => {
    expect(sameAudioFormat(PCM16_16K_MONO, { ...PCM16_16K_MONO, frameDurationMs: 20 })).toBe(true);
    expect(
      sameAudioFormat(PCM16_16K_MONO, {
        encoding: "pcm_s16le",
        sampleRateHz: 24000,
        channels: 1,
      }),
    ).toBe(false);
  });
});
