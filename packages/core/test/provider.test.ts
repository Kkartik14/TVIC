import { describe, expect, it } from "vitest";

import {
  PCM16_16K_MONO,
  evaluateProviderCompatibility,
  evaluateTtsSelectionCompatibility,
  sameAudioFormat,
  TVIC_ERROR_CODES,
  type CallHandle,
  type CallId,
  type LlmCompletionRequest,
  type Provider,
  type SessionId,
  type TextToSpeechProvider,
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

const ttsProvider = {
  ...provider,
  async synthesize() {
    return { events: (async function* () {})(), async cancel() {} };
  },
} satisfies TextToSpeechProvider;

describe("provider capability negotiation", () => {
  it("shares one selection evaluator across declared dimensions and adapter hooks", () => {
    let calls = 0;
    const selectedProvider = {
      ...ttsProvider,
      supportsTtsSelection: (selection: { readonly language?: string }) => {
        calls += 1;
        return selection.language === "hi";
      },
    } satisfies TextToSpeechProvider;

    expect(
      evaluateTtsSelectionCompatibility(
        selectedProvider,
        { model: "voice-1", voice: "calm", language: "hi" },
        { checkModel: true, checkVoice: true, checkLanguage: true },
      ),
    ).toEqual([]);
    expect(calls).toBe(1);
    expect(
      evaluateTtsSelectionCompatibility(
        selectedProvider,
        { model: "voice-1", voice: "calm", language: "en" },
        { checkModel: true, checkVoice: true, checkLanguage: true },
      ),
    ).toEqual([
      {
        requirement: "selection",
        message: "Provider does not support the selected TTS settings",
      },
    ]);
  });

  it("keeps legacy no-catalog checks permissive unless the caller requests declarations", () => {
    const hostProvider = {
      name: "host-tts",
      kind: "tts",
      version: "1.0.0",
      capabilities: {
        streaming: { input: true, output: true, native: true },
        cancellation: { request: true, output: false, buffer: false, truncation: false },
        transports: [],
        audio: { output: [PCM16_16K_MONO] },
      },
      async synthesize() {
        return { events: (async function* () {})(), async cancel() {} };
      },
    } satisfies TextToSpeechProvider;
    const selection = { model: "host-model", voice: "host-voice", language: "en-US" };

    expect(
      evaluateTtsSelectionCompatibility(hostProvider, selection, {
        checkModel: true,
        checkVoice: true,
        checkLanguage: true,
      }),
    ).toEqual([]);
    expect(
      evaluateTtsSelectionCompatibility(hostProvider, selection, {
        checkModel: true,
        checkVoice: true,
        checkLanguage: true,
        requireModelDeclaration: true,
        requireVoiceDeclaration: true,
        requireLanguageDeclaration: true,
      }).map(({ requirement }) => requirement),
    ).toEqual(["model", "voice", "language"]);
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

  it("uses TTS voice-language compatibility for a selected voice", () => {
    let receivedVoice: string | undefined;
    const voiceLanguageProvider = {
      ...ttsProvider,
      capabilities: { ...provider.capabilities, voices: ["bilingual-persona"] },
      supportsLanguage: () => false,
      supportsTtsLanguage: (language: string, model?: string, voice?: string) => {
        receivedVoice = voice;
        return language === "en" && model === "voice-1" && voice === "bilingual-persona";
      },
    } satisfies TextToSpeechProvider;

    expect(
      evaluateProviderCompatibility(voiceLanguageProvider, {
        kind: "tts",
        language: "en",
        model: "voice-1",
        voice: "bilingual-persona",
      }),
    ).toEqual({ compatible: true, issues: [] });
    expect(receivedVoice).toBe("bilingual-persona");
  });

  it("passes the complete TTS model, voice, and language selection to the adapter", () => {
    let receivedSelection:
      | { readonly model?: string; readonly voice?: string; readonly language?: string }
      | undefined;
    const selectionProvider = {
      ...ttsProvider,
      supportsTtsSelection: (selection: {
        readonly model?: string;
        readonly voice?: string;
        readonly language?: string;
      }) => {
        receivedSelection = selection;
        return true;
      },
    } satisfies TextToSpeechProvider;

    expect(
      evaluateProviderCompatibility(selectionProvider, {
        kind: "tts",
        model: "voice-1",
        voice: "calm",
        language: "hi",
      }),
    ).toEqual({ compatible: true, issues: [] });
    expect(receivedSelection).toEqual({ model: "voice-1", voice: "calm", language: "hi" });
  });

  it("fills configured defaults before calling the complete TTS selection hook", () => {
    let receivedSelection:
      | { readonly model?: string; readonly voice?: string; readonly language?: string }
      | undefined;
    const selectionProvider = {
      ...ttsProvider,
      configuredModel: "voice-1",
      configuredVoice: "calm",
      configuredLanguage: "hi",
      supportsTtsSelection: (selection: {
        readonly model?: string;
        readonly voice?: string;
        readonly language?: string;
      }) => {
        receivedSelection = selection;
        return true;
      },
    } satisfies TextToSpeechProvider;

    expect(
      evaluateProviderCompatibility(selectionProvider, {
        kind: "tts",
        model: "voice-1",
      }),
    ).toEqual({ compatible: true, issues: [] });
    expect(receivedSelection).toEqual({ model: "voice-1", voice: "calm", language: "hi" });
  });

  it("allows a complete selection hook to validate model and voice without catalogs", () => {
    const hookOnlyProvider = {
      ...ttsProvider,
      capabilities: {
        ...ttsProvider.capabilities,
        models: [],
        voices: [],
      },
      supportsTtsSelection: (selection: { readonly model?: string; readonly voice?: string }) =>
        selection.model === "host-model" && selection.voice === "host-voice",
    } satisfies TextToSpeechProvider;

    expect(
      evaluateProviderCompatibility(hookOnlyProvider, {
        kind: "tts",
        model: "host-model",
        voice: "host-voice",
      }),
    ).toEqual({ compatible: true, issues: [] });
  });

  it("matches a regional language against parent tags in a static TTS catalog", () => {
    const baseLanguageProvider = {
      ...ttsProvider,
      capabilities: { ...ttsProvider.capabilities, languages: ["en"] },
    } satisfies TextToSpeechProvider;

    expect(
      evaluateTtsSelectionCompatibility(
        baseLanguageProvider,
        { language: "en-GB" },
        { checkLanguage: true },
      ),
    ).toEqual([]);
    expect(
      evaluateTtsSelectionCompatibility(
        baseLanguageProvider,
        { language: "fr-CA" },
        { checkLanguage: true },
      ),
    ).toMatchObject([{ requirement: "language" }]);
  });

  it("checks model-required language and voice in core compatibility preflight", () => {
    const languageRequiredProvider = {
      ...ttsProvider,
      requiresTtsLanguageForModel: () => true,
    } satisfies TextToSpeechProvider;
    const voiceRequiredProvider = {
      ...ttsProvider,
      requiresTtsVoiceForModel: () => true,
    } satisfies TextToSpeechProvider;

    expect(
      evaluateProviderCompatibility(languageRequiredProvider, {
        kind: "tts",
        model: "voice-1",
      }),
    ).toMatchObject({
      compatible: false,
      issues: [{ code: "language.unsupported", requirement: "language" }],
    });
    expect(
      evaluateProviderCompatibility(voiceRequiredProvider, {
        kind: "tts",
        model: "voice-1",
      }),
    ).toMatchObject({
      compatible: false,
      issues: [{ code: TVIC_ERROR_CODES.providerVoiceUnsupported, requirement: "voice" }],
    });
  });

  it("reports an adapter-rejected model-and-voice TTS selection generically", () => {
    const selectionProvider = {
      ...ttsProvider,
      supportsTtsSelection: () => false,
    } satisfies TextToSpeechProvider;

    expect(
      evaluateProviderCompatibility(selectionProvider, {
        kind: "tts",
        model: "voice-1",
        voice: "calm",
        language: "hi",
      }),
    ).toMatchObject({
      compatible: false,
      issues: [{ code: "tts.selection_unsupported", requirement: "ttsSelection" }],
    });
  });

  it("keeps an independent language rejection alongside a failed complete selection", () => {
    const selectionProvider = {
      ...ttsProvider,
      supportsLanguage: (language: string) => language === "en",
      supportsTtsSelection: () => false,
    } satisfies TextToSpeechProvider;

    expect(
      evaluateProviderCompatibility(selectionProvider, {
        kind: "tts",
        model: "voice-1",
        voice: "calm",
        language: "hi",
      }),
    ).toMatchObject({
      compatible: false,
      issues: [{ code: "language.unsupported", requirement: "language" }],
    });
  });

  it("reports a language-only TTS selection rejection as unsupported language", () => {
    const selectionProvider = {
      ...ttsProvider,
      supportsTtsSelection: () => false,
    } satisfies TextToSpeechProvider;

    expect(
      evaluateProviderCompatibility(selectionProvider, {
        kind: "tts",
        language: "hi",
      }),
    ).toMatchObject({
      compatible: false,
      issues: [{ code: "language.unsupported", requirement: "language" }],
    });
  });

  it("preflights and rejects a model-and-voice TTS selection without a language", () => {
    let receivedSelection:
      | { readonly model?: string; readonly voice?: string; readonly language?: string }
      | undefined;
    const selectionProvider = {
      ...ttsProvider,
      supportsTtsSelection: (selection: {
        readonly model?: string;
        readonly voice?: string;
        readonly language?: string;
      }) => {
        receivedSelection = selection;
        return false;
      },
    } satisfies TextToSpeechProvider;

    expect(
      evaluateProviderCompatibility(selectionProvider, {
        kind: "tts",
        model: "voice-1",
        voice: "calm",
      }),
    ).toMatchObject({
      compatible: false,
      issues: [{ code: "tts.selection_unsupported", requirement: "ttsSelection" }],
    });
    expect(receivedSelection).toEqual({ model: "voice-1", voice: "calm" });
  });

  it("reports a missing model-required voice without marking the model unsupported", () => {
    const selectionProvider = {
      ...ttsProvider,
      requiresTtsVoiceForModel: () => true,
      supportsTtsSelection: ({ voice }: { readonly voice?: string }) => voice !== undefined,
    } satisfies TextToSpeechProvider;

    expect(
      evaluateProviderCompatibility(selectionProvider, {
        kind: "tts",
        model: "voice-1",
      }),
    ).toMatchObject({
      compatible: false,
      issues: [{ code: TVIC_ERROR_CODES.providerVoiceUnsupported, requirement: "voice" }],
    });
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
