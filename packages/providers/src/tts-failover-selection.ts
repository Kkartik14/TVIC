import { isDeepStrictEqual } from "node:util";

import {
  querySpeechControlCatalog,
  sameAudioFormat,
  TVIC_ERROR_CODES,
  TvicThrowableError,
  validationError,
  type TextToSpeechProvider,
  type TtsProviderSelection,
  type TtsSynthesisRequest,
} from "@tvic/core";

export interface TtsFailoverRequestVariant {
  readonly when?: TtsProviderSelection;
  readonly fallback: TtsProviderSelection;
}

type ProviderValueKind = "language" | "model" | "voice";

const MAX_TTS_FAILOVER_REQUEST_VARIANTS = 16;

export function normalizeFallbackRequestVariants(
  variants: readonly TtsFailoverRequestVariant[] | undefined,
  hasRequestMapper: boolean,
): readonly TtsFailoverRequestVariant[] | undefined {
  if (variants === undefined) return undefined;
  if (!hasRequestMapper) {
    throw new TypeError("TTS failover request variants require mapFallbackRequest");
  }
  if (
    !Array.isArray(variants) ||
    variants.length === 0 ||
    variants.length > MAX_TTS_FAILOVER_REQUEST_VARIANTS
  ) {
    throw new TypeError(
      `TTS failover request variants must contain one to ${MAX_TTS_FAILOVER_REQUEST_VARIANTS} entries`,
    );
  }
  return Object.freeze(
    variants.map((variant) => {
      if (
        !variant ||
        typeof variant !== "object" ||
        Object.keys(variant).some((key) => key !== "when" && key !== "fallback") ||
        !Object.prototype.hasOwnProperty.call(variant, "fallback")
      ) {
        throw new TypeError("TTS failover request variant must declare fallback settings");
      }
      return Object.freeze({
        ...(variant.when !== undefined ? { when: snapshotTtsProviderSelection(variant.when) } : {}),
        fallback: snapshotTtsProviderSelection(variant.fallback),
      });
    }),
  );
}

export function resolveFallbackSelections(
  selection: TtsProviderSelection,
  variants: readonly TtsFailoverRequestVariant[] | undefined,
  hasRequestMapper: boolean,
): readonly TtsProviderSelection[] {
  if (!hasRequestMapper) return [selection];
  if (!variants) return [];
  return variants
    .filter((variant) => matchesSelection(selection, variant.when))
    .map((variant) => Object.freeze({ ...selection, ...variant.fallback }));
}

export function selectionFromRequest(request: TtsSynthesisRequest): TtsProviderSelection {
  return {
    ...(request.model !== undefined ? { model: request.model } : {}),
    ...(request.voice !== undefined ? { voice: request.voice } : {}),
    ...(request.language !== undefined ? { language: request.language } : {}),
    ...(request.speed !== undefined ? { speed: request.speed } : {}),
    ...(request.speechControlCatalog !== undefined
      ? { speechControlCatalog: request.speechControlCatalog }
      : {}),
  };
}

export function supportsTtsFailoverSelection(
  primary: TextToSpeechProvider,
  fallback: TextToSpeechProvider,
  selection: TtsProviderSelection,
  variants: readonly TtsFailoverRequestVariant[] | undefined,
  hasRequestMapper: boolean,
): boolean {
  if (!supportsTtsProviderSelection(primary, selection)) return false;
  const fallbackSelections = resolveFallbackSelections(selection, variants, hasRequestMapper);
  return (
    fallbackSelections.length > 0 &&
    fallbackSelections.every((fallbackSelection) =>
      supportsTtsProviderSelection(fallback, fallbackSelection),
    )
  );
}

export function assertMappedRequestMatchesVariant(
  mapped: TtsSynthesisRequest,
  variants: readonly TtsProviderSelection[],
  fallback: TextToSpeechProvider,
): void {
  const actual = effectiveProviderSelection(fallback, selectionFromRequest(mapped));
  if (
    !variants.some((variant) =>
      isDeepStrictEqual(effectiveProviderSelection(fallback, variant), actual),
    )
  ) {
    throw new TypeError("TTS failover mapping must produce one declared fallback request variant");
  }
}

export function providerValueCatalog(
  provider: TextToSpeechProvider,
  kind: ProviderValueKind,
): readonly string[] | undefined {
  if (kind === "language") return provider.capabilities.languages;
  if (kind === "model") {
    return (
      provider.capabilities.models ??
      (provider.configuredModel !== undefined ? [provider.configuredModel] : undefined)
    );
  }
  return (
    provider.capabilities.voices ??
    (provider.configuredVoice !== undefined ? [provider.configuredVoice] : undefined)
  );
}

export function intersectProviderCatalogs(
  primary: TextToSpeechProvider,
  fallback: TextToSpeechProvider,
  kind: ProviderValueKind,
): readonly string[] | undefined {
  const primaryValues = providerValueCatalog(primary, kind);
  const fallbackValues = providerValueCatalog(fallback, kind);
  if (!primaryValues || !fallbackValues) return undefined;
  const fallbackSet = new Set(fallbackValues);
  return primaryValues.filter((value) => fallbackSet.has(value));
}

export function canCheckProviderValue(
  provider: TextToSpeechProvider,
  kind: "language" | "voice",
): boolean {
  if (kind === "language") {
    return (
      typeof provider.supportsLanguage === "function" ||
      (provider.capabilities.languages?.length ?? 0) > 0
    );
  }
  return (
    typeof provider.supportsVoice === "function" ||
    (provider.capabilities.voices?.length ?? 0) > 0 ||
    provider.configuredVoice !== undefined
  );
}

export function providerSupportsValue(
  provider: TextToSpeechProvider,
  kind: "language" | "voice",
  value: string,
  model?: string,
): boolean {
  if (kind === "language") {
    return (
      provider.supportsLanguage?.call(provider, value, model) ??
      provider.capabilities.languages?.includes(value) ??
      false
    );
  }
  return (
    provider.supportsVoice?.call(provider, value, model) ??
    provider.capabilities.voices?.includes(value) ??
    provider.configuredVoice === value
  );
}

export function assertFallbackRequestSupported(
  fallback: TextToSpeechProvider,
  request: TtsSynthesisRequest,
): void {
  const outputFormats = fallback.capabilities.audio?.output;
  if (!outputFormats?.some((format) => sameAudioFormat(format, request.format))) {
    throw TvicThrowableError.from(
      validationError(
        TVIC_ERROR_CODES.providerInvalidRequest,
        `TTS failover fallback ${fallback.name} does not declare support for the requested output format`,
        { provider: fallback.name, metadata: { format: request.format } },
      ),
    );
  }

  const model = request.model ?? fallback.configuredModel;
  const voice = request.voice ?? fallback.configuredVoice;
  const language = request.language ?? fallback.configuredLanguage;
  if (fallback.supportsTtsSelection) {
    const selection: TtsProviderSelection = {
      ...(model !== undefined ? { model } : {}),
      ...(voice !== undefined ? { voice } : {}),
      ...(language !== undefined ? { language } : {}),
      ...(request.speed !== undefined ? { speed: request.speed } : {}),
      ...(request.speechControlCatalog !== undefined
        ? { speechControlCatalog: request.speechControlCatalog }
        : {}),
    };
    if (!fallback.supportsTtsSelection(selection)) {
      throw TvicThrowableError.from(
        validationError(
          TVIC_ERROR_CODES.providerInvalidRequest,
          `TTS failover fallback ${fallback.name} does not support the selected settings`,
          { provider: fallback.name, metadata: { ...selection } },
        ),
      );
    }
    return;
  }

  const models = providerValueCatalog(fallback, "model");
  if (
    model !== undefined &&
    models &&
    !models.includes(model) &&
    fallback.allowUnknownModel !== true
  ) {
    throw TvicThrowableError.from(
      validationError(
        TVIC_ERROR_CODES.providerModelUnsupported,
        `TTS failover fallback ${fallback.name} does not support model ${model}`,
        { provider: fallback.name, metadata: { model } },
      ),
    );
  }

  if (voice !== undefined && !providerSupportsValue(fallback, "voice", voice, model)) {
    throw TvicThrowableError.from(
      validationError(
        TVIC_ERROR_CODES.providerVoiceUnsupported,
        `TTS failover fallback ${fallback.name} does not support voice ${voice}`,
        { provider: fallback.name, metadata: { model, voice } },
      ),
    );
  }

  const requiresLanguage = fallback.requiresTtsLanguageForModel?.(model) === true;
  if (
    (request.language !== undefined || requiresLanguage) &&
    (language === undefined ||
      fallback.supportsTtsLanguage === undefined ||
      !fallback.supportsTtsLanguage(language, model, voice))
  ) {
    throw TvicThrowableError.from(
      validationError(
        TVIC_ERROR_CODES.ttsLanguageUnsupported,
        `TTS failover fallback ${fallback.name} does not support language ${language ?? "not provided"}`,
        { provider: fallback.name, metadata: { model, voice, language } },
      ),
    );
  }

  if (
    request.speed !== undefined &&
    (fallback.supportsTtsSpeed === undefined ||
      !fallback.supportsTtsSpeed(request.speed, model, voice))
  ) {
    throw TvicThrowableError.from(
      validationError(
        TVIC_ERROR_CODES.providerInvalidRequest,
        `TTS failover fallback ${fallback.name} does not support speed ${request.speed}`,
        { provider: fallback.name, metadata: { model, voice, speed: request.speed } },
      ),
    );
  }
}

function snapshotTtsProviderSelection(value: TtsProviderSelection): TtsProviderSelection {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) => key !== "model" && key !== "voice" && key !== "language" && key !== "speed",
    )
  ) {
    throw new TypeError(
      "TTS failover selection must contain only model, voice, language, and speed",
    );
  }
  const { model, voice, language, speed } = value;
  if (
    (model !== undefined && (typeof model !== "string" || model.trim().length === 0)) ||
    (voice !== undefined && (typeof voice !== "string" || voice.trim().length === 0)) ||
    (language !== undefined && (typeof language !== "string" || language.trim().length === 0)) ||
    (speed !== undefined && (!Number.isFinite(speed) || speed <= 0))
  ) {
    throw new TypeError("TTS failover selection contains an invalid setting");
  }
  return Object.freeze({
    ...(model !== undefined ? { model } : {}),
    ...(voice !== undefined ? { voice } : {}),
    ...(language !== undefined ? { language } : {}),
    ...(speed !== undefined ? { speed } : {}),
  });
}

function supportsTtsProviderSelection(
  provider: TextToSpeechProvider,
  selection: TtsProviderSelection,
): boolean {
  if (provider.requiresAccountVoiceCatalog === true) {
    const accountVoiceCatalogProviders = provider.accountVoiceCatalogProviders ?? [provider.name];
    if (accountVoiceCatalogProviders.includes(provider.name)) {
      const catalog = selection.speechControlCatalog;
      const voice = selection.voice ?? provider.configuredVoice;
      if (!catalog || !voice) return false;
      if (
        querySpeechControlCatalog(catalog, {
          provider: provider.name,
          control: "tts.voice",
          ...((selection.model ?? provider.configuredModel)
            ? { model: selection.model ?? provider.configuredModel }
            : {}),
          voice,
        }).status !== "supported"
      ) {
        return false;
      }
    } else if (!provider.supportsTtsSelection) {
      return false;
    }
  }
  if (provider.supportsTtsSelection) return provider.supportsTtsSelection(selection);

  const model = selection.model ?? provider.configuredModel;
  if (model !== undefined) {
    const models = providerValueCatalog(provider, "model");
    if (
      !models?.includes(model) &&
      model !== provider.configuredModel &&
      provider.allowUnknownModel !== true
    ) {
      return false;
    }
  }

  const voice = selection.voice ?? provider.configuredVoice;
  if (voice !== undefined && !providerSupportsValue(provider, "voice", voice, model)) return false;

  const requiresLanguage = provider.requiresTtsLanguageForModel?.(model) === true;
  const language = selection.language ?? provider.configuredLanguage;
  if (
    (selection.language !== undefined || requiresLanguage) &&
    (language === undefined ||
      provider.supportsTtsLanguage === undefined ||
      !provider.supportsTtsLanguage(language, model, voice))
  ) {
    return false;
  }

  return (
    selection.speed === undefined ||
    (provider.supportsTtsSpeed !== undefined &&
      provider.supportsTtsSpeed(selection.speed, model, voice))
  );
}

function matchesSelection(
  selection: TtsProviderSelection,
  expected: TtsProviderSelection | undefined,
): boolean {
  if (!expected) return true;
  return Object.entries(expected).every(
    ([key, value]) => selection[key as keyof TtsProviderSelection] === value,
  );
}

function effectiveProviderSelection(
  provider: TextToSpeechProvider,
  selection: TtsProviderSelection,
): TtsProviderSelection {
  const model = selection.model ?? provider.configuredModel;
  const voice = selection.voice ?? provider.configuredVoice;
  const language = selection.language ?? provider.configuredLanguage;
  return {
    ...(model !== undefined ? { model } : {}),
    ...(voice !== undefined ? { voice } : {}),
    ...(language !== undefined ? { language } : {}),
    ...(selection.speed !== undefined ? { speed: selection.speed } : {}),
    ...(selection.speechControlCatalog !== undefined
      ? { speechControlCatalog: selection.speechControlCatalog }
      : {}),
  };
}
