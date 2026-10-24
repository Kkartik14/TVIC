import { describe, expect, it } from "vitest";

import {
  createSpeechControlCatalogSnapshot,
  querySpeechControlCatalog,
  type TextToSpeechProvider,
} from "@tvic/core";
import { resolveTtsCallSelection } from "../src/tts-selection.js";
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
      speed: 1.1,
    });
  });

  it("keeps configured model and voice when no override is requested", () => {
    expect(resolveTtsCallSelection(provider, {})).toEqual({
      model: "model-default",
      modelSource: "configured",
      voice: "voice-default",
    });
  });

  it("validates the provider's configured language against a call-level model", () => {
    const configuredLanguageProvider = {
      ...provider,
      configuredLanguage: "or-IN",
      supportsTtsLanguage: (language: string, model?: string) =>
        language === "or-IN" && model === "model-default",
    } as unknown as TextToSpeechProvider;

    expect(() =>
      resolveTtsCallSelection(configuredLanguageProvider, { model: "model-call" }),
    ).toThrow(/does not support TTS language or-IN/u);
  });

  it("validates the configured language against an overridden account voice", () => {
    const accountProvider = {
      ...provider,
      name: "account-tts",
      configuredLanguage: "hi-IN",
      languageWasExplicitlyConfigured: true,
      requiresAccountVoiceCatalog: true,
      supportsTtsLanguage: () => true,
    } as unknown as TextToSpeechProvider;
    const catalog = createSpeechControlCatalogSnapshot(
      [
        {
          provider: "account-tts",
          control: "tts.voice",
          scope: { type: "account", model: "model-default", voice: "voice-call" },
          status: "supported",
          mutability: "provider",
          source: "https://provider.example/voices",
          verifiedAt: "2026-10-24",
        },
        {
          provider: "account-tts",
          control: "tts.voice",
          scope: { type: "account", model: "model-default", voice: "voice-default" },
          status: "supported",
          mutability: "provider",
          source: "https://provider.example/voices",
          verifiedAt: "2026-10-24",
        },
        {
          provider: "account-tts",
          control: "tts.language",
          scope: { type: "account", model: "model-default", voice: "voice-call" },
          status: "supported",
          mutability: "call",
          source: "https://provider.example/voices",
          verifiedAt: "2026-10-24",
          languages: ["en-IN"],
        },
        {
          provider: "account-tts",
          control: "tts.language",
          scope: { type: "account", model: "model-default", voice: "voice-default" },
          status: "supported",
          mutability: "call",
          source: "https://provider.example/voices",
          verifiedAt: "2026-10-24",
          languages: ["en-IN"],
        },
      ],
      {
        fetchedAt: new Date(Date.now() - 1_000).toISOString(),
        validUntil: new Date(Date.now() + 60_000).toISOString(),
      },
    );

    expect(() =>
      resolveTtsCallSelection(accountProvider, { voice: "voice-call" }, {}, catalog),
    ).toThrow(/does not support TTS language hi-IN/u);
    expect(() => resolveTtsCallSelection(accountProvider, {}, {}, catalog)).toThrow(
      /does not support TTS language hi-IN/u,
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

  it("uses an owned model catalog fact to reject unsupported and unknown model selections", () => {
    const catalogProvider = {
      ...provider,
      allowUnknownModel: true,
    } as unknown as TextToSpeechProvider;
    const catalog = createSpeechControlCatalogSnapshot(
      [
        {
          provider: "selection-tts",
          control: "tts.model",
          scope: { type: "model", model: "model-call" },
          status: "unsupported",
          mutability: "provider",
          source: "https://provider.example/models",
          verifiedAt: "2026-10-24",
        },
      ],
      {
        fetchedAt: new Date(Date.now() - 1_000).toISOString(),
        validUntil: new Date(Date.now() + 60_000).toISOString(),
      },
    );

    expect(() =>
      resolveTtsCallSelection(catalogProvider, { model: "model-call" }, {}, catalog),
    ).toThrow(/Speech control catalog unsupported for TTS model model-call/u);
    expect(() =>
      resolveTtsCallSelection(catalogProvider, { model: "unknown-model" }, {}, catalog),
    ).toThrow(/Speech control catalog unknown for TTS model unknown-model/u);
  });

  it("rechecks the effective configured model against catalog expiry for each call", () => {
    const catalog = createSpeechControlCatalogSnapshot(
      [
        {
          provider: "selection-tts",
          control: "tts.model",
          scope: { type: "model", model: "model-default" },
          status: "supported",
          mutability: "provider",
          source: "https://provider.example/models",
          verifiedAt: "2026-10-20",
        },
      ],
      {
        fetchedAt: "2026-10-20T00:00:00.000Z",
        validUntil: "2026-10-21T00:00:00.000Z",
      },
    );

    expect(() => resolveTtsCallSelection(provider, {}, {}, catalog)).toThrow(
      /Speech control catalog expired for TTS model model-default/u,
    );
  });

  it("rechecks the effective configured account voice against catalog expiry for each call", () => {
    const catalog = createSpeechControlCatalogSnapshot(
      [
        {
          provider: "selection-tts",
          control: "tts.voice",
          scope: { type: "account", voice: "voice-default" },
          status: "supported",
          mutability: "provider",
          source: "https://provider.example/voices",
          verifiedAt: "2026-10-20",
        },
      ],
      {
        fetchedAt: "2026-10-20T00:00:00.000Z",
        validUntil: "2026-10-21T00:00:00.000Z",
      },
    );

    expect(() => resolveTtsCallSelection(provider, {}, {}, catalog)).toThrow(
      /Speech control catalog expired for TTS voice voice-default/u,
    );
  });

  it("rejects explicit normalization and dictionary settings when the provider does not declare them", () => {
    const controls = {
      textNormalization: "off",
      pronunciationDictionaries: [{ id: "tenant-dictionary", version: "v2" }],
    } as TtsCallSelectionInput;

    expect(() => resolveTtsCallSelection(provider, controls)).toThrow(
      /does not declare support for request-level TTS text normalization/u,
    );
  });

  it("passes the current catalog to model-gated normalization validation", () => {
    const catalog = createSpeechControlCatalogSnapshot(
      [
        {
          provider: "selection-tts",
          control: "tts.text_normalization.forced",
          scope: { type: "account", model: "model-call" },
          status: "supported",
          mutability: "call",
          source: "https://provider.example/account/subscription",
          verifiedAt: "2026-10-24",
        },
      ],
      {
        fetchedAt: new Date(Date.now() - 1_000).toISOString(),
        validUntil: new Date(Date.now() + 60_000).toISOString(),
      },
    );
    const catalogAwareProvider = {
      ...provider,
      supportsTtsTextNormalization: (
        normalization: unknown,
        selection: { readonly model?: string; readonly speechControlCatalog?: typeof catalog },
      ) =>
        normalization === "on" &&
        selection.model === "model-call" &&
        selection.speechControlCatalog !== undefined &&
        querySpeechControlCatalog(selection.speechControlCatalog, {
          provider: "selection-tts",
          control: "tts.text_normalization.forced",
          model: "model-call",
        }).status === "supported",
    } as unknown as TextToSpeechProvider;

    expect(
      resolveTtsCallSelection(
        catalogAwareProvider,
        { model: "model-call", textNormalization: "on" },
        {},
        catalog,
      ),
    ).toMatchObject({ model: "model-call", textNormalization: "on" });
  });

  it("passes the current catalog to account-gated typed text operation validation", () => {
    const catalog = createSpeechControlCatalogSnapshot(
      [
        {
          provider: "selection-tts",
          control: "tts.text_operations",
          scope: { type: "account", model: "model-default", voice: "voice-default" },
          status: "supported",
          mutability: "call",
          source: "https://provider.example/account/capabilities",
          verifiedAt: "2026-10-24",
        },
      ],
      {
        fetchedAt: new Date(Date.now() - 1_000).toISOString(),
        validUntil: new Date(Date.now() + 60_000).toISOString(),
      },
    );
    const catalogAwareProvider = {
      ...provider,
      usageAccounting: { reportsTextCharacters: true },
      supportsTtsTextOperations: (
        _operations: readonly { readonly type: "spell"; readonly match: string }[],
        selection: {
          readonly model?: string;
          readonly voice?: string;
          readonly speechControlCatalog?: typeof catalog;
        },
      ) =>
        selection.speechControlCatalog !== undefined &&
        querySpeechControlCatalog(selection.speechControlCatalog, {
          provider: "selection-tts",
          control: "tts.text_operations",
          ...(selection.model !== undefined ? { model: selection.model } : {}),
          ...(selection.voice !== undefined ? { voice: selection.voice } : {}),
        }).status === "supported",
    } as unknown as TextToSpeechProvider;

    expect(
      resolveTtsCallSelection(
        catalogAwareProvider,
        { textOperations: [{ type: "spell", match: "AB12" }] },
        {},
        catalog,
      ),
    ).toMatchObject({ textOperations: [{ type: "spell", match: "AB12" }] });
  });

  it("passes the current catalog to account-gated pronunciation dictionary validation", () => {
    const catalog = createSpeechControlCatalogSnapshot(
      [
        {
          provider: "selection-tts",
          control: "tts.pronunciation_dictionary",
          scope: { type: "account", model: "model-default", voice: "voice-default" },
          status: "supported",
          mutability: "call",
          source: "https://provider.example/account/dictionaries",
          verifiedAt: "2026-10-24",
        },
      ],
      {
        fetchedAt: new Date(Date.now() - 1_000).toISOString(),
        validUntil: new Date(Date.now() + 60_000).toISOString(),
      },
    );
    const catalogAwareProvider = {
      ...provider,
      supportsTtsPronunciationDictionaries: (
        dictionaries: readonly { readonly id: string }[],
        selection: {
          readonly model?: string;
          readonly voice?: string;
          readonly speechControlCatalog?: typeof catalog;
        },
      ) =>
        dictionaries[0]?.id === "account-dictionary" &&
        selection.speechControlCatalog !== undefined &&
        querySpeechControlCatalog(selection.speechControlCatalog, {
          provider: "selection-tts",
          control: "tts.pronunciation_dictionary",
          ...(selection.model !== undefined ? { model: selection.model } : {}),
          ...(selection.voice !== undefined ? { voice: selection.voice } : {}),
        }).status === "supported",
    } as unknown as TextToSpeechProvider;

    expect(
      resolveTtsCallSelection(
        catalogAwareProvider,
        { pronunciationDictionaries: [{ id: "account-dictionary" }] },
        {},
        catalog,
      ),
    ).toMatchObject({ pronunciationDictionaries: [{ id: "account-dictionary" }] });
  });

  it("validates and snapshots declared per-call normalization and dictionary references", () => {
    const declaredProvider = {
      ...provider,
      supportsTtsTextNormalization: (normalization: unknown) => normalization === "off",
      supportsTtsPronunciationDictionaries: (dictionaries: readonly { id: string }[]) =>
        dictionaries.length === 1 && dictionaries[0]?.id === "tenant-dictionary",
    } as unknown as TextToSpeechProvider;
    const dictionaries = [{ id: "tenant-dictionary", version: "v2" }];

    const selected = resolveTtsCallSelection(declaredProvider, {
      textNormalization: "off",
      pronunciationDictionaries: dictionaries,
    } as TtsCallSelectionInput);

    expect(selected).toMatchObject({
      textNormalization: "off",
      pronunciationDictionaries: [{ id: "tenant-dictionary", version: "v2" }],
    });
    expect(selected.pronunciationDictionaries).not.toBe(dictionaries);
    expect(Object.isFrozen(selected.pronunciationDictionaries)).toBe(true);
  });

  it("accepts a provider-managed custom voice only from a current account snapshot", () => {
    const accountProvider = {
      ...provider,
      name: "account-tts",
      supportsVoice: () => true,
    } as unknown as TextToSpeechProvider;
    const catalog = createSpeechControlCatalogSnapshot(
      [
        {
          provider: "account-tts",
          control: "tts.voice",
          scope: { type: "account", model: "model-default", voice: "tenant-voice" },
          status: "supported",
          mutability: "provider",
          source: "https://provider.example/api/voices",
          verifiedAt: "2026-10-20",
        },
      ],
      {
        fetchedAt: "2020-01-01T00:00:00.000Z",
        validUntil: "2099-01-01T00:00:00.000Z",
      },
    );
    const expiredCatalog = createSpeechControlCatalogSnapshot(
      [
        {
          provider: "account-tts",
          control: "tts.voice",
          scope: { type: "account", model: "model-default", voice: "tenant-voice" },
          status: "supported",
          mutability: "provider",
          source: "https://provider.example/api/voices",
          verifiedAt: "2020-01-01",
        },
      ],
      {
        fetchedAt: "2000-01-01T00:00:00.000Z",
        validUntil: "2001-01-01T00:00:00.000Z",
      },
    );

    expect(
      resolveTtsCallSelection(accountProvider, { voice: "tenant-voice" }, {}, catalog),
    ).toMatchObject({
      voice: "tenant-voice",
      model: "model-default",
    });
    expect(() =>
      resolveTtsCallSelection(accountProvider, { voice: "missing-voice" }, {}, catalog),
    ).toThrow(/catalog unknown/u);
    expect(() =>
      resolveTtsCallSelection(accountProvider, { voice: "tenant-voice" }, {}, expiredCatalog),
    ).toThrow(/catalog expired/u);
  });

  it("requires catalog membership and provider route support for a voice", () => {
    const routeRestrictedProvider = {
      ...provider,
      name: "selection-tts",
      supportsVoice: (voice: string, model?: string) =>
        voice === "voice-call" && model === "model-call",
    } as unknown as TextToSpeechProvider;
    const catalog = createSpeechControlCatalogSnapshot(
      [
        {
          provider: "selection-tts",
          control: "tts.voice",
          scope: { type: "account", voice: "voice-call" },
          status: "supported",
          mutability: "provider",
          source: "https://provider.example/api/voices",
          verifiedAt: "2026-10-20",
        },
      ],
      {
        fetchedAt: new Date(Date.now() - 1_000).toISOString(),
        validUntil: new Date(Date.now() + 60_000).toISOString(),
      },
    );

    expect(() =>
      resolveTtsCallSelection(
        routeRestrictedProvider,
        {
          model: "model-default",
          voice: "voice-call",
        },
        {},
        catalog,
      ),
    ).toThrow(/does not support voice voice-call/u);
  });

  it("requires an account snapshot when the adapter declares account-owned voices", () => {
    const accountProvider = {
      ...provider,
      requiresAccountVoiceCatalog: true,
    } as unknown as TextToSpeechProvider;

    expect(() => resolveTtsCallSelection(accountProvider, { voice: "voice-call" })).toThrow(
      /requires a current account voice catalog/u,
    );
  });

  it("uses the call snapshot when validating an account voice override", () => {
    const accountProvider = {
      ...provider,
      name: "cartesia",
      requiresAccountVoiceCatalog: true,
      supportsVoice: () => false,
      supportsTtsSelection: (selection: {
        readonly model?: string;
        readonly voice?: string;
        readonly speechControlCatalog?: ReturnType<typeof createSpeechControlCatalogSnapshot>;
      }) =>
        selection.speechControlCatalog !== undefined &&
        selection.voice !== undefined &&
        querySpeechControlCatalog(selection.speechControlCatalog, {
          provider: "cartesia",
          control: "tts.voice",
          ...(selection.model !== undefined ? { model: selection.model } : {}),
          voice: selection.voice,
        }).status === "supported",
    } as unknown as TextToSpeechProvider;
    const catalog = createSpeechControlCatalogSnapshot(
      [
        {
          provider: "cartesia",
          control: "tts.voice",
          scope: { type: "account", model: "model-default", voice: "voice-call" },
          status: "supported",
          mutability: "provider",
          source: "https://api.cartesia.ai/voices/voice-call",
          verifiedAt: "2026-10-25",
        },
      ],
      {
        fetchedAt: new Date(Date.now() - 1_000).toISOString(),
        validUntil: new Date(Date.now() + 60_000).toISOString(),
      },
    );

    expect(
      resolveTtsCallSelection(accountProvider, { voice: "voice-call" }, {}, catalog),
    ).toMatchObject({
      model: "model-default",
      voice: "voice-call",
    });
  });

  it("does not replace missing account voice-language facts with model support", () => {
    const accountProvider = {
      ...provider,
      name: "account-language-tts",
      requiresAccountVoiceCatalog: true,
      accountVoiceCatalogControls: ["tts.language"],
      supportsTtsLanguage: () => true,
    } as unknown as TextToSpeechProvider;
    const catalog = createSpeechControlCatalogSnapshot(
      [
        {
          provider: "account-language-tts",
          control: "tts.language",
          scope: { type: "model", model: "model-default" },
          status: "supported",
          mutability: "call",
          source: "https://provider.example/models",
          verifiedAt: "2026-10-20",
          languages: ["hi-IN"],
        },
        {
          provider: "account-language-tts",
          control: "tts.voice",
          scope: { type: "account", voice: "voice-default" },
          status: "supported",
          mutability: "provider",
          source: "https://provider.example/api/voices",
          verifiedAt: "2026-10-20",
        },
      ],
      {
        fetchedAt: new Date(Date.now() - 1_000).toISOString(),
        validUntil: new Date(Date.now() + 60_000).toISOString(),
      },
    );

    expect(() =>
      resolveTtsCallSelection(
        accountProvider,
        { voice: "voice-default", language: "hi-IN" },
        {},
        catalog,
      ),
    ).toThrow(/does not support TTS language hi-IN/u);
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

  it("rejects typed text operations unless the adapter declares safe serialization and usage", () => {
    const operations = [{ type: "spell", match: "AB12" }] as const;
    expect(() => resolveTtsCallSelection(provider, { textOperations: operations })).toThrow(
      /does not declare support for typed TTS text operations/u,
    );

    const incomplete = {
      ...provider,
      supportsTtsTextOperations: () => true,
    } as unknown as TextToSpeechProvider;
    expect(() => resolveTtsCallSelection(incomplete, { textOperations: operations })).toThrow(
      /must report provider-bound TTS characters/u,
    );
  });

  it("freezes supported typed text operations into the call selection", () => {
    const operations = [{ type: "spell", match: "AB12" }] as const;
    const capable = {
      ...provider,
      usageAccounting: { reportsTextCharacters: true },
      supportsTtsTextOperations: (requested: readonly unknown[], selection: { model?: string }) =>
        requested.length === 1 && selection.model === "model-default",
    } as unknown as TextToSpeechProvider;

    const selection = resolveTtsCallSelection(capable, { textOperations: operations });
    expect(selection.textOperations).toEqual(operations);
    expect(Object.isFrozen(selection.textOperations)).toBe(true);
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

    expect(() => resolveTtsCallSelection(sarvamV4, {})).toThrow(/requires a TTS language/u);
    expect(resolveTtsCallSelection(sarvamV4, { language: "en-IN" })).toMatchObject({
      model: "bulbul:v4-flash",
      voice: "simran_en_customer",
      language: "en-IN",
    });
    expect(() => resolveTtsCallSelection(sarvamV4, { language: "hi-IN" })).toThrow(
      /does not support TTS language hi-IN/u,
    );
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
    });
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

  it("validates every voice-language map entry before selecting the call voice", () => {
    const mapProvider = {
      ...provider,
      supportsTtsLanguage: (language: string, model?: string, voice?: string) =>
        language === "hi-IN" && model === "model-default" && voice === "voice-call",
    } as unknown as TextToSpeechProvider;
    const overrides: TtsCallSelectionInput = {
      language: "hi-IN",
      voicesByLanguage: { "hi-IN": "voice-call", "en-US": "voice-default" },
    };

    expect(() => resolveTtsCallSelection(mapProvider, overrides)).toThrow(
      /does not support TTS language en-US for model model-default and voice voice-default/u,
    );
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
});
