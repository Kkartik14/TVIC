import { describe, expect, it, vi } from "vitest";

import type { TextToSpeechProvider } from "@tvic/core";
import { TVIC_ERROR_CODES } from "@tvic/core";
import { assertResolvedTtsCallSelection, resolveTtsCallSelection } from "../src/tts-selection.js";
import type { TtsCallSelectionInput } from "../src/tts-selection.js";

const provider = {
  name: "selection-tts",
  kind: "tts",
  version: "1.0.0",
  capabilities: {
    streaming: { input: true, output: true, native: true },
    cancellation: { request: true, output: true, buffer: true, truncation: true },
    transports: ["websocket"],
    models: ["model-default", "model-call"],
    voices: ["voice-default", "voice-call"],
  },
  configuredModel: "model-default",
  configuredVoice: "voice-default",
  supportsTtsLanguage: (language: string, model?: string, voice?: string) =>
    language === "hi-IN" && model === "model-call" && voice === "voice-call",
  supportsTtsSpeed: (speed: number, model?: string, voice?: string) =>
    speed === 1.1 && model === "model-call" && voice === "voice-call",
  synthesize: async () => {
    throw new Error("not used");
  },
} as unknown as TextToSpeechProvider;

describe("resolveTtsCallSelection", () => {
  it("uses request overrides and validates them against the selected model and voice", () => {
    expect(
      resolveTtsCallSelection(provider, {
        model: "model-call",
        voice: "voice-call",
        language: "hi-IN",
        speed: 1.1,
      }),
    ).toEqual({
      model: "model-call",
      modelSource: "request",
      voice: "voice-call",
      language: "hi-IN",
      languageWasExplicitlySelected: true,
      languageWasCallerSelected: true,
      speed: 1.1,
    });
  });

  it("honors an explicit model source alongside a model override", () => {
    expect(
      resolveTtsCallSelection(provider, { model: "model-call", modelSource: "configured" }),
    ).toMatchObject({ model: "model-call", modelSource: "configured" });
  });

  it("canonicalizes legacy Filipino tags before provider compatibility checks", () => {
    const filipinoProvider = {
      ...provider,
      supportsTtsLanguage: (language: string) => language === "fil",
    } as unknown as TextToSpeechProvider;

    expect(resolveTtsCallSelection(filipinoProvider, { language: "tl" })).toMatchObject({
      language: "fil",
    });
  });

  it("ignores TTS settings when no TTS provider is configured", () => {
    expect(
      resolveTtsCallSelection(undefined, {
        model: "model-call",
        modelSource: "configured",
        voice: "voice-call",
        language: "hi-IN",
        speed: 1.1,
      }),
    ).toEqual({
      modelSource: "configured",
      languageWasExplicitlySelected: true,
      languageWasCallerSelected: true,
    });
  });

  it("keeps configured model and voice when no override is requested", () => {
    expect(resolveTtsCallSelection(provider, {})).toEqual({
      model: "model-default",
      modelSource: "configured",
      voice: "voice-default",
      languageWasExplicitlySelected: false,
      languageWasCallerSelected: false,
    });
  });

  it("keeps an inherited configured language lenient when a call selects another model", () => {
    const configuredLanguageProvider = {
      ...provider,
      configuredLanguage: "or-IN",
      supportsTtsLanguage: (language: string, model?: string) =>
        language === "or-IN" && model === "model-default",
    } as unknown as TextToSpeechProvider;

    expect(
      resolveTtsCallSelection(configuredLanguageProvider, { model: "model-call" }),
    ).toMatchObject({ model: "model-call", voice: "voice-default" });
  });

  it("does not turn an inherited configured language into a request-level override", () => {
    const configuredLanguageProvider = {
      ...provider,
      configuredModel: "eleven_multilingual_v2",
      configuredLanguage: "en",
      supportsTtsLanguage: () => false,
    } as unknown as TextToSpeechProvider;

    expect(resolveTtsCallSelection(configuredLanguageProvider, {})).toMatchObject({
      model: "eleven_multilingual_v2",
      voice: "voice-default",
    });
  });

  it("does not revalidate an inherited configured language on every call", () => {
    const hostProvider = {
      ...provider,
      configuredLanguage: "en-US",
      capabilities: { ...provider.capabilities, languages: ["en", "hi"] },
      supportsTtsLanguage: undefined,
    } as unknown as TextToSpeechProvider;

    expect(resolveTtsCallSelection(hostProvider, {})).toMatchObject({
      model: "model-default",
      voice: "voice-default",
    });
  });

  it("preserves a legacy configured TTS language when the call omits language selection", () => {
    const legacyProvider = {
      ...provider,
      configuredLanguage: "en-US",
      supportsTtsLanguage: undefined,
      supportsTtsSelection: undefined,
    } as unknown as TextToSpeechProvider;

    expect(resolveTtsCallSelection(legacyProvider, {})).toMatchObject({
      model: "model-default",
      voice: "voice-default",
    });
  });

  it("keeps caller language provenance separate from a default language", () => {
    const selectionCheck = vi.fn(() => true);
    const languageProvider = {
      ...provider,
      configuredModel: "model-call",
      configuredLanguage: "en-IN",
      supportsTtsLanguage: () => true,
      requiresTtsLanguageForModel: () => true,
      languageWasExplicitlyConfigured: true,
      supportsTtsSelection: selectionCheck,
    } as unknown as TextToSpeechProvider;

    expect(resolveTtsCallSelection(languageProvider, {}, { language: "en-IN" })).toMatchObject({
      language: "en-IN",
      languageWasExplicitlySelected: true,
      languageWasCallerSelected: false,
    });
    expect(selectionCheck).toHaveBeenLastCalledWith(
      expect.objectContaining({ language: "en-IN" }),
      { languageWasExplicitlySelected: true, languageWasCallerSelected: false },
    );

    expect(resolveTtsCallSelection(languageProvider, { language: "en-IN" })).toMatchObject({
      language: "en-IN",
      languageWasExplicitlySelected: true,
      languageWasCallerSelected: true,
    });
    expect(selectionCheck).toHaveBeenLastCalledWith(
      expect.objectContaining({ language: "en-IN" }),
      { languageWasExplicitlySelected: true, languageWasCallerSelected: true },
    );
  });

  it("preserves a host provider's non-BCP-47 configured language without language hooks", () => {
    const legacyProvider = {
      ...provider,
      configuredLanguage: "en_US",
      supportsTtsLanguage: undefined,
      supportsTtsSelection: undefined,
    } as unknown as TextToSpeechProvider;

    expect(() => resolveTtsCallSelection(legacyProvider, {})).not.toThrow();
  });

  it("does not validate an unused voice map against a legacy configured language", () => {
    const legacyProvider = {
      ...provider,
      configuredLanguage: "en_US",
      supportsTtsLanguage: undefined,
      supportsTtsSelection: undefined,
    } as unknown as TextToSpeechProvider;

    expect(
      resolveTtsCallSelection(legacyProvider, { voicesByLanguage: { "en-US": "voice-map" } }),
    ).toMatchObject({ voice: "voice-default" });
  });

  it("preserves a legacy configured language when a selection hook validates a model override", () => {
    const selection = vi.fn(
      (value: { model?: string; language?: string }) =>
        value.model === "model-call" && value.language === "en_US",
    );
    const legacyProvider = {
      ...provider,
      configuredLanguage: "en_US",
      supportsTtsLanguage: undefined,
      supportsTtsSelection: selection,
    } as unknown as TextToSpeechProvider;

    expect(resolveTtsCallSelection(legacyProvider, { model: "model-call" })).toMatchObject({
      model: "model-call",
    });
    expect(selection).toHaveBeenCalledWith(
      {
        model: "model-call",
        voice: "voice-default",
        language: "en_US",
      },
      { languageWasExplicitlySelected: false, languageWasCallerSelected: false },
    );
  });

  it("rejects unknown models and voices before a call starts", () => {
    expect(() => resolveTtsCallSelection(provider, { model: "unknown" })).toThrow(
      /does not support model unknown/u,
    );
    expect(() => resolveTtsCallSelection(provider, { voice: "unknown" })).toThrow(
      /does not support voice unknown/u,
    );
  });

  it("rejects explicit language and speed when the adapter has no declarations", () => {
    const undeclared = { ...provider } as unknown as TextToSpeechProvider;
    Object.defineProperty(undeclared, "supportsTtsLanguage", { value: undefined });
    Object.defineProperty(undeclared, "supportsTtsSpeed", { value: undefined });

    expect(() => resolveTtsCallSelection(undeclared, { language: "hi-IN" })).toThrow(
      /does not declare support for request-level TTS language/u,
    );
    expect(() => resolveTtsCallSelection(undeclared, { speed: 1.1 })).toThrow(
      /does not declare support for request-level TTS speed/u,
    );
  });

  it("rejects an unsupported language or speed for the chosen model and voice", () => {
    expect(() =>
      resolveTtsCallSelection(provider, { model: "model-default", language: "hi-IN" }),
    ).toThrow(/does not support TTS language hi-IN/u);
    expect(() => resolveTtsCallSelection(provider, { model: "model-default", speed: 1.1 })).toThrow(
      /does not support TTS speed 1.1/u,
    );
  });

  it("rejects a selected call when the provider preflight rejects the combined settings", () => {
    const preflightProvider = {
      ...provider,
      supportsTtsSelection: (selection: {
        readonly model?: string;
        readonly voice?: string;
        readonly language?: string;
        readonly speed?: number;
      }) =>
        !(
          selection.model === "model-call" &&
          selection.voice === "voice-call" &&
          selection.language === "hi-IN" &&
          selection.speed === 1.1
        ),
    } as unknown as TextToSpeechProvider;

    expect(() =>
      resolveTtsCallSelection(preflightProvider, {
        model: "model-call",
        voice: "voice-call",
        language: "hi-IN",
        speed: 1.1,
      }),
    ).toThrow(/does not support the selected TTS settings/u);
  });

  it("requires and validates a language for providers that require one on the selected model", () => {
    const sarvamV4 = {
      ...provider,
      configuredModel: "bulbul:v4-flash",
      configuredVoice: "simran_en_customer",
      configuredLanguage: "en-IN",
      languageWasExplicitlyConfigured: false,
      capabilities: {
        ...provider.capabilities,
        models: ["bulbul:v4-flash"],
        voices: ["simran_en_customer"],
      },
      requiresTtsLanguageForModel: (model?: string) => model === "bulbul:v4-flash",
      supportsTtsLanguage: (language: string, model?: string, voice?: string) =>
        language === "en-IN" && model === "bulbul:v4-flash" && voice === "simran_en_customer",
    } as unknown as TextToSpeechProvider;

    expect(() => resolveTtsCallSelection(sarvamV4, {})).toThrow(
      /requires an explicitly selected TTS language/u,
    );
    expect(resolveTtsCallSelection(sarvamV4, { language: "en-IN" })).toMatchObject({
      model: "bulbul:v4-flash",
      voice: "simran_en_customer",
      language: "en-IN",
    });
    expect(() => resolveTtsCallSelection(sarvamV4, { language: "hi-IN" })).toThrow(
      /does not support TTS language hi-IN/u,
    );
  });

  it("explains when a model needs a language beyond an implicit provider default", () => {
    const implicitLanguageProvider = {
      ...provider,
      configuredLanguage: "en-IN",
      languageWasExplicitlyConfigured: false,
      requiresTtsLanguageForModel: () => true,
      supportsTtsLanguage: () => true,
      supportsTtsSelection: () => false,
    } as unknown as TextToSpeechProvider;

    expect(() => resolveTtsCallSelection(implicitLanguageProvider, {})).toThrow(
      /requires an explicitly selected TTS language/u,
    );
  });

  it("accepts an explicit host default for a model that requires a language", () => {
    const selectionCheck = vi.fn(() => true);
    const failoverProvider = {
      ...provider,
      name: "tts-failover:primary->sarvam",
      configuredModel: "primary-model",
      configuredLanguage: "en-IN",
      languageWasExplicitlyConfigured: false,
      requiresTtsLanguageForModel: () => true,
      supportsTtsLanguage: () => true,
      supportsTtsSelection: selectionCheck,
    } as unknown as TextToSpeechProvider;

    expect(
      resolveTtsCallSelection(
        failoverProvider,
        {},
        {
          model: "primary-model",
          modelSource: "configured",
          language: "en-IN",
        },
      ),
    ).toMatchObject({
      language: "en-IN",
      languageWasExplicitlySelected: true,
      languageWasCallerSelected: false,
    });
    expect(selectionCheck).toHaveBeenLastCalledWith(
      expect.objectContaining({ language: "en-IN" }),
      { languageWasExplicitlySelected: true, languageWasCallerSelected: false },
    );
  });

  it("requires a call-level voice for providers that require one on the selected model", () => {
    const sarvamV4 = {
      ...provider,
      configuredModel: "bulbul:v4-flash",
      configuredVoice: undefined,
      configuredLanguage: "en-IN",
      languageWasExplicitlyConfigured: true,
      capabilities: {
        ...provider.capabilities,
        models: ["bulbul:v4-flash"],
        voices: ["simran_en_customer"],
      },
      requiresTtsLanguageForModel: (model?: string) => model === "bulbul:v4-flash",
      requiresTtsVoiceForModel: (model?: string) => model === "bulbul:v4-flash",
      supportsTtsLanguage: (language: string, model?: string, voice?: string) =>
        language === "en-IN" && model === "bulbul:v4-flash" && voice === "simran_en_customer",
    } as unknown as TextToSpeechProvider;

    expect(() => resolveTtsCallSelection(sarvamV4, { language: "en-IN" })).toThrow(
      /requires a TTS voice/u,
    );
    expect(
      resolveTtsCallSelection(sarvamV4, {
        voice: "simran_en_customer",
        language: "en-IN",
      }),
    ).toMatchObject({ voice: "simran_en_customer", language: "en-IN" });
  });

  it("uses an explicitly configured provider language for models that require one", () => {
    const sarvamV4 = {
      ...provider,
      configuredModel: "bulbul:v4-flash",
      configuredVoice: "simran_en_customer",
      configuredLanguage: "en-IN",
      languageWasExplicitlyConfigured: true,
      capabilities: {
        ...provider.capabilities,
        models: ["bulbul:v4-flash"],
        voices: ["simran_en_customer"],
      },
      requiresTtsLanguageForModel: (model?: string) => model === "bulbul:v4-flash",
      supportsTtsLanguage: (language: string, model?: string, voice?: string) =>
        language === "en-IN" && model === "bulbul:v4-flash" && voice === "simran_en_customer",
    } as unknown as TextToSpeechProvider;

    expect(resolveTtsCallSelection(sarvamV4, {})).toMatchObject({
      language: "en-IN",
    });
  });

  it("treats a host-supplied default language as explicit but not caller-selected", () => {
    const selectionCheck = vi.fn(() => true);
    const languageProvider = {
      ...provider,
      configuredLanguage: undefined,
      languageWasExplicitlyConfigured: false,
      requiresTtsLanguageForModel: () => true,
      supportsTtsLanguage: () => true,
      supportsTtsSelection: selectionCheck,
    } as unknown as TextToSpeechProvider;

    expect(resolveTtsCallSelection(languageProvider, {}, { language: "hi-IN" })).toMatchObject({
      language: "hi-IN",
      languageWasExplicitlySelected: true,
      languageWasCallerSelected: false,
    });
    expect(selectionCheck).toHaveBeenLastCalledWith(
      expect.objectContaining({ language: "hi-IN" }),
      { languageWasExplicitlySelected: true, languageWasCallerSelected: false },
    );
  });

  it("validates an inherited voice against a run-level model override", () => {
    const sarvam = {
      ...provider,
      configuredModel: "bulbul:v4-flash",
      configuredVoice: "simran_en_customer",
      configuredLanguage: "en-IN",
      languageWasExplicitlyConfigured: true,
      capabilities: {
        ...provider.capabilities,
        models: ["bulbul:v4-flash", "bulbul:v3"],
        voices: ["simran_en_customer"],
      },
      supportsVoice: (voice: string, model?: string) =>
        voice === "simran_en_customer" && model === "bulbul:v4-flash",
      supportsTtsLanguage: (language: string, model?: string) =>
        language === "en-IN" && model === "bulbul:v3",
    } as unknown as TextToSpeechProvider;

    expect(() => resolveTtsCallSelection(sarvam, { model: "bulbul:v3" })).toThrow(
      /does not support voice simran_en_customer/u,
    );
  });

  it("selects a fixed call voice from the output language map without changing the model", () => {
    const overrides = {
      model: "model-call",
      language: "hi-in",
      voicesByLanguage: { "hi-IN": "voice-call" },
    };

    expect(resolveTtsCallSelection(provider, overrides)).toEqual({
      model: "model-call",
      modelSource: "request",
      voice: "voice-call",
      language: "hi-IN",
      languageWasExplicitlySelected: true,
      languageWasCallerSelected: true,
    });
  });

  it("falls back to a base-language voice map entry when no exact locale is mapped", () => {
    expect(
      resolveTtsCallSelection(provider, {
        model: "model-call",
        language: "hi-IN",
        voicesByLanguage: { hi: "voice-call" },
      }),
    ).toEqual({
      model: "model-call",
      modelSource: "request",
      voice: "voice-call",
      language: "hi-IN",
      languageWasExplicitlySelected: true,
      languageWasCallerSelected: true,
    });
  });

  it("checks a base-language voice-map key against base-only provider catalogs", () => {
    const baseCatalogProvider = {
      ...provider,
      capabilities: {
        ...provider.capabilities,
        languages: ["hi"],
      },
      supportsTtsLanguage: undefined,
    } as unknown as TextToSpeechProvider;

    expect(
      resolveTtsCallSelection(baseCatalogProvider, {
        model: "model-call",
        language: "hi-IN",
        voicesByLanguage: { hi: "voice-call" },
      }),
    ).toMatchObject({ model: "model-call", voice: "voice-call", language: "hi-IN" });
  });

  it("falls back through intermediate script subtags in a voice map", () => {
    const regionalProvider = {
      ...provider,
      configuredModel: "model-call",
      configuredVoice: "voice-default",
      supportsTtsLanguage: (language: string) => language === "zh-Hans-CN",
      supportsVoice: (voice: string) => voice === "voice-call",
    } as unknown as TextToSpeechProvider;

    expect(
      resolveTtsCallSelection(regionalProvider, {
        language: "zh-Hans-CN",
        voicesByLanguage: { "zh-Hans": "voice-call", zh: "voice-default" },
      }),
    ).toMatchObject({ language: "zh-Hans-CN", voice: "voice-call" });
  });

  it("keeps legacy host model and voice overrides lenient when no catalogs exist", () => {
    const hostProvider = {
      ...provider,
      configuredModel: "host-default-model",
      configuredVoice: "host-default-voice",
      capabilities: {
        ...provider.capabilities,
        models: undefined,
        voices: undefined,
      },
      supportsTtsLanguage: undefined,
      supportsTtsSpeed: undefined,
      supportsTtsSelection: undefined,
      supportsVoice: undefined,
    } as unknown as TextToSpeechProvider;

    expect(
      resolveTtsCallSelection(hostProvider, {
        model: "host-call-model",
        voice: "host-call-voice",
      }),
    ).toMatchObject({ model: "host-call-model", voice: "host-call-voice" });
  });

  it("can consume a resolved selection as defaults without changing it", () => {
    const selected = resolveTtsCallSelection(provider, {
      model: "model-call",
      voice: "voice-call",
      language: "hi-IN",
      speed: 1.1,
    });

    expect(resolveTtsCallSelection(provider, {}, selected)).toEqual(selected);
  });

  it("validates only the selected regional language for unused base-language map entries", () => {
    const regionalLanguageProvider = {
      ...provider,
      supportsTtsLanguage: (language: string) => language === "hi-IN" || language === "ta-IN",
    } as unknown as TextToSpeechProvider;

    expect(
      resolveTtsCallSelection(regionalLanguageProvider, {
        language: "hi-IN",
        voicesByLanguage: { hi: "voice-call", ta: "voice-default" },
      }),
    ).toMatchObject({ language: "hi-IN", voice: "voice-call" });
  });

  it("does not let a base voice-map key override a regional language hook rejection", () => {
    const regionalLanguageProvider = {
      ...provider,
      supportsTtsLanguage: (language: string) => language === "en" || language === "hi",
    } as unknown as TextToSpeechProvider;

    expect(() =>
      resolveTtsCallSelection(regionalLanguageProvider, {
        language: "en-GB",
        voicesByLanguage: { en: "voice-call" },
      }),
    ).toThrow(/does not support TTS language en-GB/u);
  });

  it("matches regional TTS languages to base-language static catalogs", () => {
    const staticCatalogProvider = {
      ...provider,
      capabilities: { ...provider.capabilities, languages: ["hi"] },
      supportsTtsLanguage: undefined,
    } as unknown as TextToSpeechProvider;

    expect(resolveTtsCallSelection(staticCatalogProvider, { language: "hi-IN" })).toMatchObject({
      language: "hi-IN",
    });
  });

  it("applies and validates a default speed when no request override is supplied", () => {
    expect(
      resolveTtsCallSelection(
        provider,
        {},
        { model: "model-call", voice: "voice-call", speed: 1.1 },
      ),
    ).toEqual({
      model: "model-call",
      modelSource: "configured",
      voice: "voice-call",
      speed: 1.1,
      languageWasExplicitlySelected: false,
      languageWasCallerSelected: false,
    });
    expect(() =>
      resolveTtsCallSelection(
        provider,
        {},
        { model: "model-call", voice: "voice-call", speed: 1.2 },
      ),
    ).toThrow(/does not support TTS speed 1\.2/u);
  });

  it("passes each mapped language into strict voice override preflight", () => {
    const languageAwareProvider = {
      ...provider,
      supportsTtsVoiceOverride: (voice: string, model?: string, language?: string) =>
        voice === "voice-call" && model === "model-call" && language === "hi-IN",
    } as unknown as TextToSpeechProvider;

    expect(
      resolveTtsCallSelection(languageAwareProvider, {
        model: "model-call",
        language: "hi-IN",
        voicesByLanguage: { "hi-IN": "voice-call" },
      }),
    ).toMatchObject({ model: "model-call", voice: "voice-call", language: "hi-IN" });
  });

  it("uses the run-level voice map in place of the configured map", () => {
    const overrides: TtsCallSelectionInput = {
      model: "model-call",
      language: "hi-IN",
      voicesByLanguage: { "hi-IN": "voice-call" },
    };

    expect(
      resolveTtsCallSelection(provider, overrides, {
        voicesByLanguage: { "hi-IN": "voice-default" },
      }),
    ).toMatchObject({ model: "model-call", voice: "voice-call", language: "hi-IN" });
  });

  it("validates only the voice-language map entry selected for this call", () => {
    const mapProvider = {
      ...provider,
      supportsTtsLanguage: (language: string, model?: string, voice?: string) =>
        language === "hi-IN" && model === "model-default" && voice === "voice-call",
    } as unknown as TextToSpeechProvider;
    const overrides: TtsCallSelectionInput = {
      language: "hi-IN",
      voicesByLanguage: { "hi-IN": "voice-call", "en-US": "voice-default" },
    };

    expect(resolveTtsCallSelection(mapProvider, overrides)).toMatchObject({
      language: "hi-IN",
      voice: "voice-call",
    });
  });

  it("rejects oversized voice-language maps before normalizing their entries", () => {
    const voicesByLanguage = Object.fromEntries(
      Array.from({ length: 129 }, (_, index) => [
        `en-x-${index.toString(36).padStart(3, "0")}`,
        `voice-${index}`,
      ]),
    );

    expect(() =>
      resolveTtsCallSelection(provider, {
        voicesByLanguage,
      }),
    ).toThrow(/at most 128 entries/u);
  });

  it("uses a fixed language catalog when a provider declares only capabilities.languages", () => {
    const languageCatalogProvider = {
      ...provider,
      supportsTtsLanguage: undefined,
      capabilities: { ...provider.capabilities, languages: ["en-US"] },
    } as unknown as TextToSpeechProvider;

    expect(resolveTtsCallSelection(languageCatalogProvider, { language: "en-us" })).toMatchObject({
      language: "en-US",
    });
  });

  it("keeps an inherited configured voice when a model override omits it from the catalog snapshot", () => {
    const snapshotProvider = {
      ...provider,
      configuredModel: "model-default",
      configuredVoice: "configured-voice",
      capabilities: {
        ...provider.capabilities,
        models: ["model-default", "model-call"],
        voices: ["other-voice"],
      },
      supportsVoice: (voice: string) => voice === "configured-voice",
      supportsTtsVoiceOverride: () => false,
    } as unknown as TextToSpeechProvider;

    expect(resolveTtsCallSelection(snapshotProvider, { model: "model-call" })).toMatchObject({
      model: "model-call",
      voice: "configured-voice",
    });
    expect(() =>
      resolveTtsCallSelection(snapshotProvider, { model: "model-call", voice: "other-voice" }),
    ).toThrow(/does not support voice other-voice/u);
  });

  it("lets an explicit voice override an unused language-map voice", () => {
    expect(
      resolveTtsCallSelection(provider, {
        model: "model-call",
        voice: "voice-call",
        language: "hi-IN",
        voicesByLanguage: { hi: "voice-not-in-catalog" },
      }),
    ).toMatchObject({ voice: "voice-call", language: "hi-IN" });
  });

  it("does not use an unused voice-map key to validate an explicit voice language", () => {
    const baseLanguageCatalogProvider = {
      ...provider,
      capabilities: {
        ...provider.capabilities,
        languages: ["ta"],
        voices: ["explicit-voice"],
      },
      supportsTtsLanguage: undefined,
    } as unknown as TextToSpeechProvider;

    expect(() =>
      resolveTtsCallSelection(baseLanguageCatalogProvider, {
        model: "model-call",
        voice: "explicit-voice",
        language: "hi-IN",
        voicesByLanguage: { hi: "mapped-voice" },
      }),
    ).toThrow(/does not support TTS language hi-IN/u);
  });

  it("treats empty direct-loop model, voice, and language overrides as omitted", () => {
    expect(resolveTtsCallSelection(provider, { model: "", voice: "", language: "" })).toMatchObject(
      {
        model: "model-default",
        modelSource: "configured",
        voice: "voice-default",
      },
    );
  });

  it("binds a resolved selection to the provider used to resolve it", () => {
    const selection = resolveTtsCallSelection(provider, {});
    const otherProvider = { ...provider, name: "other-tts" } as unknown as TextToSpeechProvider;

    expect(() => assertResolvedTtsCallSelection(selection, provider)).not.toThrow();
    expect(() => assertResolvedTtsCallSelection(selection, otherProvider)).toThrow(
      expect.objectContaining({
        code: TVIC_ERROR_CODES.providerInvalidRequest,
        message: expect.stringContaining("different TTS provider"),
      }),
    );
  });
});
