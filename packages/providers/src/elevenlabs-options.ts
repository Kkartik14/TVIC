import type WebSocket from "ws";

import {
  PROVIDER_CAPABILITY_FEATURES,
  PROVIDER_ERROR_CODES,
  PROVIDER_NAMES,
  TVIC_ERROR_CODES,
  TvicThrowableError,
  canonicalizeLanguageTag,
  primaryLanguageSubtag,
  resolveProviderCapability,
  validationError,
} from "@tvic/core";
import { ELEVENLABS_CAPABILITY_FEATURES } from "./elevenlabs-capability-features.js";
import type {
  ProviderCapabilityQuery,
  ProviderCapabilityResolution,
  ProviderCapabilitySnapshot,
  ProviderTtsSpeedRange,
  TtsSessionOpenRequest,
} from "@tvic/core";

import { PROVIDER_CATALOG } from "./catalog.js";
import { providerError, type ProviderClock } from "./common.js";

export type ElevenLabsTtsProtocol = "tts" | "dialogue";

export const ELEVENLABS_TTS_SPEED_RANGE = Object.freeze({ min: 0.7, max: 1.2 });

export type ElevenLabsTextNormalization = "auto" | "on" | "off";

export function requiredElevenLabsCapabilityQueries(
  modelId: string,
  normalization: ElevenLabsTextNormalization | undefined,
  protocol = elevenLabsWebSocketProtocol(modelId),
  useSpeakerBoost = false,
): readonly ProviderCapabilityQuery[] | undefined {
  const queries: ProviderCapabilityQuery[] = [
    {
      provider: PROVIDER_NAMES.elevenlabs,
      feature: PROVIDER_CAPABILITY_FEATURES.ttsModelAvailable,
      scope: "model",
      model: modelId,
    },
  ];
  if (protocol === "tts") {
    queries.push({
      provider: PROVIDER_NAMES.elevenlabs,
      feature: PROVIDER_CAPABILITY_FEATURES.ttsModelCanDoTextToSpeech,
      scope: "model",
      model: modelId,
    });
  }
  if (protocol === "tts" && useSpeakerBoost) {
    queries.push({
      provider: PROVIDER_NAMES.elevenlabs,
      feature: ELEVENLABS_CAPABILITY_FEATURES.ttsModelCanUseSpeakerBoost,
      scope: "model",
      model: modelId,
      expectedBooleanValue: true,
    });
  }
  if (
    normalization === "on" &&
    PROVIDER_CATALOG.elevenlabs.forcedNormalizationModels?.some((model) => model === modelId)
  ) {
    queries.push({
      provider: PROVIDER_NAMES.elevenlabs,
      feature: ELEVENLABS_CAPABILITY_FEATURES.ttsForcedNormalization,
      scope: "account",
    });
  }
  return Object.freeze(queries.map((query) => Object.freeze(query)));
}

export const ELEVENLABS_TTS_CHARACTER_LIMITS: Readonly<Record<string, number | undefined>> = {
  eleven_v3: 5_000,
  eleven_v3_conversational: 5_000,
  eleven_v4: 10_000,
  eleven_multilingual_v2: 10_000,
  eleven_flash_v2_5: 40_000,
  eleven_flash_v2: 30_000,
  eleven_turbo_v2_5: 40_000,
  eleven_turbo_v2: 30_000,
};

const ELEVENLABS_COMMON_LANGUAGES = new Set([
  "ar",
  "bg",
  "zh",
  "hr",
  "cs",
  "da",
  "nl",
  "en",
  "fil",
  "fi",
  "fr",
  "de",
  "el",
  "hi",
  "id",
  "it",
  "ja",
  "ko",
  "ms",
  "pl",
  "pt",
  "ro",
  "ru",
  "sk",
  "es",
  "sv",
  "ta",
  "tr",
  "uk",
]);
const ELEVENLABS_FLASH_V2_5_LANGUAGES = new Set([...ELEVENLABS_COMMON_LANGUAGES, "hu", "no", "vi"]);
export interface ElevenLabsPronunciationDictionaryLocator {
  readonly id: string;
  readonly versionId?: string;
}

export interface ElevenLabsTtsSendTextOptions {
  readonly tryTriggerGeneration?: boolean;
}

export interface ElevenLabsDialogueTurnOptions {
  readonly voiceId?: string;
  readonly newTurn?: boolean;
}

export interface ElevenLabsTtsProviderOptions {
  readonly apiKey: string;
  readonly voiceId: string;
  readonly modelId?: string;
  readonly language?: string;
  readonly url?: string;
  readonly allowUnknownModel?: boolean;
  readonly stability?: number;
  readonly similarityBoost?: number;
  readonly useSpeakerBoost?: boolean;
  readonly autoMode?: boolean;
  readonly chunkLengthSchedule?: readonly number[];
  readonly applyTextNormalization?: ElevenLabsTextNormalization;
  readonly enableLogging?: boolean;
  readonly enableSsmlParsing?: boolean;
  readonly seed?: number;
  readonly inactivityTimeoutSeconds?: number;
  readonly pronunciationDictionaryLocators?: readonly ElevenLabsPronunciationDictionaryLocator[];
  readonly knownVoiceIds?: readonly string[];
  readonly dialogueVoices?: readonly string[];
  readonly clock?: ProviderClock;
  readonly webSocketFactory?: (url: string, headers: Readonly<Record<string, string>>) => WebSocket;
}

type ElevenLabsModelSelectionOptions = Pick<
  ElevenLabsTtsProviderOptions,
  | "language"
  | "enableSsmlParsing"
  | "similarityBoost"
  | "seed"
  | "autoMode"
  | "chunkLengthSchedule"
  | "useSpeakerBoost"
  | "inactivityTimeoutSeconds"
  | "dialogueVoices"
> & { readonly voiceId?: string };

export function assertElevenLabsRequest(
  request: TtsSessionOpenRequest,
  options: ElevenLabsTtsProviderOptions,
  protocol: ElevenLabsTtsProtocol,
  voice: string,
  additionalVoices: readonly string[] = [],
): void {
  const model = request.model ?? options.modelId ?? PROVIDER_CATALOG.elevenlabs.defaultModel;
  assertElevenLabsLanguageSetting(options, model, protocol);
  const language = resolveElevenLabsTtsLanguage(request.language, options.language);
  if (
    language !== undefined &&
    !supportsElevenLabsTtsLanguage(language, model, options.allowUnknownModel === true)
  ) {
    throw elevenLabsLanguageUnsupportedError(language, model);
  }
  if (!isValidElevenLabsVoiceId(voice)) {
    throw TvicThrowableError.from(
      validationError(TVIC_ERROR_CODES.providerVoiceUnsupported, "ElevenLabs voice id is invalid", {
        provider: PROVIDER_NAMES.elevenlabs,
      }),
    );
  }
  assertKnownElevenLabsVoice(voice, options, protocol);
  assertElevenLabsSpeed(request.speed);
  assertElevenLabsRange(
    "stability",
    options.stability === undefined ? 0.5 : options.stability,
    0,
    1,
  );
  assertElevenLabsRange(
    "similarityBoost",
    options.similarityBoost === undefined ? 0.8 : options.similarityBoost,
    0,
    1,
  );
  assertElevenLabsBoolean("autoMode", options.autoMode);
  assertElevenLabsBoolean("enableLogging", options.enableLogging);
  assertElevenLabsBoolean("enableSsmlParsing", options.enableSsmlParsing);
  assertElevenLabsBoolean("useSpeakerBoost", options.useSpeakerBoost);
  assertElevenLabsNormalization(options.applyTextNormalization);
  assertElevenLabsInactivityTimeout(options.inactivityTimeoutSeconds);
  assertElevenLabsChunkLengthSchedule(options.chunkLengthSchedule);
  assertElevenLabsPronunciationDictionaries(options.pronunciationDictionaryLocators);
  assertElevenLabsConfiguredModelOptions(options, protocol, model);
  if (request.speed !== undefined) {
    const customModelOptIn = options.allowUnknownModel === true && !isElevenLabsCatalogModel(model);
    if (
      protocol === "dialogue" ||
      (!supportsElevenLabsTtsSpeed(request.speed, model) && !customModelOptIn)
    ) {
      throw elevenLabsSpeedUnsupportedError(
        "speed is not supported by this ElevenLabs model or route",
      );
    }
  }
  assertElevenLabsCapabilityRequirements(
    request,
    options,
    model,
    voice,
    additionalVoices,
    protocol,
  );
}

function assertElevenLabsCapabilityRequirements(
  request: TtsSessionOpenRequest,
  options: ElevenLabsModelSelectionOptions &
    Pick<ElevenLabsTtsProviderOptions, "voiceId" | "modelId" | "applyTextNormalization">,
  model: string,
  voice: string,
  additionalVoices: readonly string[],
  protocol: ElevenLabsTtsProtocol,
): void {
  const snapshots = request.providerCapabilitySnapshots;
  const hasSnapshots = snapshots !== undefined;
  const voices = [...new Set([voice, ...additionalVoices])];
  const evaluationTimeMs = request.providerCapabilityEvaluationTimeMs ?? Date.now();

  if (hasSnapshots) {
    for (const query of requiredElevenLabsCapabilityQueries(
      model,
      options.applyTextNormalization,
      protocol,
      options.useSpeakerBoost === true,
    ) ?? []) {
      assertCapabilityQuery(snapshots ?? [], query, evaluationTimeMs);
    }
  }

  for (const selectedVoice of voices) {
    assertElevenLabsVoiceAvailable(snapshots, model, selectedVoice, evaluationTimeMs);
  }

  const configuredLanguage = resolveElevenLabsTtsLanguage(undefined, options.language);
  if (hasSnapshots && configuredLanguage !== undefined && protocol === "tts") {
    const resolution = resolveProviderCapability(
      snapshots ?? [],
      {
        provider: PROVIDER_NAMES.elevenlabs,
        feature: ELEVENLABS_CAPABILITY_FEATURES.ttsVoiceVerifiedLocales,
        scope: "voice",
        model,
        voice,
      },
      evaluationTimeMs,
    );
    if (resolution.status !== "supported") {
      throw capabilitySnapshotError(
        `ElevenLabs requires ${ELEVENLABS_CAPABILITY_FEATURES.ttsVoiceVerifiedLocales} support for voice ${voice}, but its capability snapshot is ${capabilityState(resolution)}`,
      );
    }
    const locales = Array.isArray(resolution.value) ? resolution.value : [];
    if (
      !locales.some(
        (locale) => typeof locale === "string" && matchesLocale(configuredLanguage, locale),
      )
    ) {
      throw capabilitySnapshotError(
        `ElevenLabs configured language is not verified for voice ${voice}`,
      );
    }
  }
}

function assertCapabilityQuery(
  snapshots: readonly ProviderCapabilitySnapshot[],
  query: ProviderCapabilityQuery,
  evaluationTimeMs: number,
): void {
  const resolution = resolveProviderCapability(snapshots, query, evaluationTimeMs);
  if (
    resolution.status === "supported" &&
    (query.expectedBooleanValue === undefined || resolution.value === query.expectedBooleanValue)
  ) {
    return;
  }
  const state =
    resolution.status === "unknown"
      ? resolution.reason
      : query.expectedBooleanValue !== undefined &&
          typeof resolution.value === "boolean" &&
          resolution.value !== query.expectedBooleanValue
        ? `value_${resolution.value}`
        : resolution.status === "supported"
          ? resolution.value === undefined
            ? "value_missing"
            : `value_${resolution.value}`
          : resolution.status;
  throw capabilitySnapshotError(
    `ElevenLabs requires ${query.feature}${query.expectedBooleanValue === undefined ? " support" : ` value ${query.expectedBooleanValue}`}, but its capability snapshot is ${state}`,
  );
}

function assertElevenLabsVoiceAvailable(
  snapshots: readonly ProviderCapabilitySnapshot[] | undefined,
  model: string,
  voice: string,
  evaluationTimeMs: number,
): void {
  if (snapshots === undefined) return;
  const query = {
    provider: PROVIDER_NAMES.elevenlabs,
    feature: PROVIDER_CAPABILITY_FEATURES.ttsVoiceAvailable,
    scope: "voice" as const,
    model,
    voice,
  };
  const resolution = resolveProviderCapability(snapshots, query, evaluationTimeMs);
  if (resolution.status === "supported") return;
  throw capabilitySnapshotError(
    `ElevenLabs cannot use voice ${voice}: capability snapshot is ${capabilityState(resolution)} for model ${model}`,
  );
}

function capabilityState(resolution: ProviderCapabilityResolution): string {
  return resolution.status === "unknown" ? resolution.reason : resolution.status;
}

function matchesLocale(language: string, verifiedLocale: string): boolean {
  try {
    const requested = new Intl.Locale(Intl.getCanonicalLocales(language)[0]!);
    const verified = new Intl.Locale(Intl.getCanonicalLocales(verifiedLocale)[0]!);
    return (
      requested.language === verified.language &&
      (!requested.script || !verified.script || requested.script === verified.script) &&
      (!requested.region || !verified.region || requested.region === verified.region)
    );
  } catch {
    return false;
  }
}

function capabilitySnapshotError(message: string): TvicThrowableError {
  return TvicThrowableError.from(
    providerError(PROVIDER_ERROR_CODES.elevenlabsTts, message, {
      provider: PROVIDER_NAMES.elevenlabs,
      retriable: false,
    }),
  );
}

export function supportsElevenLabsConfiguredModelSelection(
  options: ElevenLabsModelSelectionOptions,
  model: string,
): boolean {
  try {
    const protocol = elevenLabsWebSocketProtocol(model);
    assertElevenLabsLanguageSetting(options, model, protocol);
    assertElevenLabsConfiguredModelOptions(options, protocol, model);
    if (
      protocol === "dialogue" &&
      (options.dialogueVoices !== undefined || options.voiceId !== undefined)
    ) {
      resolveDialogueVoices(
        model,
        options.dialogueVoices?.[0] ?? options.voiceId ?? "",
        options.dialogueVoices,
      );
    }
    return true;
  } catch {
    return false;
  }
}

function assertElevenLabsConfiguredModelOptions(
  options: ElevenLabsModelSelectionOptions,
  protocol: ElevenLabsTtsProtocol,
  model: string,
): void {
  assertElevenLabsSsmlSetting(options, protocol);
  assertElevenLabsSeed(options.seed, protocol);
  if (
    protocol === "dialogue" &&
    model.startsWith("eleven_v3") &&
    options.similarityBoost !== undefined
  ) {
    throw elevenLabsOptionError(
      "similarityBoost is not supported by ElevenLabs v3 dialogue models",
    );
  }
  if (options.autoMode === true && options.chunkLengthSchedule !== undefined) {
    throw elevenLabsOptionError("autoMode cannot be combined with chunkLengthSchedule");
  }
  if (options.useSpeakerBoost !== undefined && protocol === "dialogue") {
    throw elevenLabsOptionError("useSpeakerBoost is only supported by regular ElevenLabs TTS");
  }
  if (options.autoMode !== undefined && protocol === "dialogue") {
    throw elevenLabsOptionError("autoMode is only supported by regular ElevenLabs TTS");
  }
  if (options.chunkLengthSchedule !== undefined && protocol === "dialogue") {
    throw elevenLabsOptionError("chunkLengthSchedule is only supported by regular ElevenLabs TTS");
  }
  if (options.inactivityTimeoutSeconds !== undefined && protocol === "dialogue") {
    throw elevenLabsOptionError(
      "inactivityTimeoutSeconds is only supported by regular ElevenLabs TTS",
    );
  }
  if (protocol === "tts" && options.dialogueVoices !== undefined) {
    throw elevenLabsOptionError("dialogueVoices requires an ElevenLabs dialogue model");
  }
}

export function assertElevenLabsLanguageSetting(
  options: Pick<ElevenLabsTtsProviderOptions, "language">,
  model: string,
  protocol: ElevenLabsTtsProtocol,
): void {
  if (resolveElevenLabsTtsLanguage(undefined, options.language) === undefined) return;
  if (protocol === "dialogue") {
    throw elevenLabsOptionError("language_code is not supported by ElevenLabs dialogue models");
  }
  if (model === "eleven_multilingual_v2") {
    throw elevenLabsOptionError("language_code is not supported by eleven_multilingual_v2");
  }
}

export function assertElevenLabsSsmlSetting(
  options: Pick<ElevenLabsTtsProviderOptions, "enableSsmlParsing">,
  protocol: ElevenLabsTtsProtocol,
  transport: "websocket" | "http" = "websocket",
): void {
  if (options.enableSsmlParsing !== undefined && protocol === "dialogue") {
    throw elevenLabsOptionError("enableSsmlParsing is only supported by regular ElevenLabs TTS");
  }
  // The HTTP routes take no SSML flag and always interpret SSML-style tags, so an opt-in
  // is already the behavior (accepted, nothing sent) while an opt-out cannot be honored.
  if (options.enableSsmlParsing === false && transport === "http") {
    throw elevenLabsOptionError(
      "enableSsmlParsing: false is not supported on the ElevenLabs HTTP routes, which always interpret SSML-style tags; false is only honored on the ElevenLabs WebSocket routes",
    );
  }
}

export function resolveElevenLabsSsmlParsing(
  options: Pick<
    ElevenLabsTtsProviderOptions,
    "enableSsmlParsing" | "pronunciationDictionaryLocators"
  >,
  protocol: ElevenLabsTtsProtocol,
): boolean | undefined {
  if (protocol === "dialogue") return undefined;
  if (options.enableSsmlParsing !== undefined) return options.enableSsmlParsing;
  if ((options.pronunciationDictionaryLocators?.length ?? 0) > 0) return undefined;
  return false;
}

export function supportsElevenLabsTtsLanguage(
  language: string,
  model?: string,
  allowUnknownModel = false,
): boolean {
  const code = toElevenLabsLanguageCode(language);
  if (!code || !model) {
    return false;
  }
  if (!isElevenLabsCatalogModel(model)) return allowUnknownModel;
  // This model auto-detects the language and rejects an explicit language_code.
  if (model === "eleven_multilingual_v2") return false;
  if (model === "eleven_flash_v2_5" || model === "eleven_turbo_v2_5") {
    return ELEVENLABS_FLASH_V2_5_LANGUAGES.has(code);
  }
  if (model === "eleven_flash_v2" || model === "eleven_turbo_v2") return code === "en";
  // Vendor docs describe v3/v4 as supporting 70+/90+ languages and publish
  // representative lists, not closed catalogs. Keep syntactically valid BCP-47
  // tags available for these expanding model families.
  if (model.startsWith("eleven_v3") || model.startsWith("eleven_v4")) return true;
  return false;
}

export function toElevenLabsLanguageCode(language: string): string | undefined {
  const canonical = canonicalizeLanguageTag(language);
  if (!canonical) return undefined;
  const primary = primaryLanguageSubtag(canonical);
  // The API names Norwegian with its macrolanguage code (`no`); map the
  // common Bokmål and Nynorsk BCP-47 primary subtags to that code.
  return primary === "nb" || primary === "nn" ? "no" : primary;
}

/** Empty per-call/configured language strings mean no language override. */
export function resolveElevenLabsTtsLanguage(
  requestLanguage: string | undefined,
  configuredLanguage: string | undefined,
): string | undefined {
  const configured = configuredLanguage === "" ? undefined : configuredLanguage;
  return requestLanguage === "" ? configured : (requestLanguage ?? configured);
}

export function supportsElevenLabsTtsSpeed(
  speed: number,
  model?: string,
  allowUnknownModel = false,
): boolean {
  return (
    Number.isFinite(speed) &&
    speed >= ELEVENLABS_TTS_SPEED_RANGE.min &&
    speed <= ELEVENLABS_TTS_SPEED_RANGE.max &&
    model !== undefined &&
    elevenLabsWebSocketProtocol(model) === "tts" &&
    (allowUnknownModel || isElevenLabsCatalogModel(model))
  );
}

function isElevenLabsCatalogModel(model: string): boolean {
  return PROVIDER_CATALOG.elevenlabs.models.some((supportedModel) => supportedModel === model);
}

export function resolveDialogueVoices(
  model: string,
  primaryVoice: string,
  configuredVoices: readonly string[] | undefined,
): readonly string[] {
  const voices = configuredVoices === undefined ? [primaryVoice] : configuredVoices;
  assertElevenLabsVoices(voices);
  if (!voices.includes(primaryVoice)) {
    throw elevenLabsOptionError("dialogueVoices must include the session's selected voice");
  }
  if (model === "eleven_v3_conversational" && voices.length !== 1) {
    throw elevenLabsOptionError(
      "eleven_v3_conversational accepts exactly one registered dialogue voice",
    );
  }
  if (model === "eleven_v3" && voices.length > 10) {
    throw elevenLabsOptionError("eleven_v3 accepts at most ten registered dialogue voices");
  }
  if (model === "eleven_v4_turbo" && voices.length !== 1) {
    throw elevenLabsOptionError("eleven_v4_turbo accepts exactly one registered dialogue voice");
  }
  if (model === "eleven_v4" && voices.length > 10) {
    throw elevenLabsOptionError("eleven_v4 accepts at most ten registered dialogue voices");
  }
  return voices;
}

export function toProviderPronunciationDictionaries(
  locators: readonly ElevenLabsPronunciationDictionaryLocator[],
): readonly Readonly<Record<string, string>>[] {
  return locators.map((locator) => ({
    id: locator.id,
    ...(locator.versionId !== undefined ? { version_id: locator.versionId } : {}),
  }));
}

export function elevenLabsWebSocketProtocol(model: string): ElevenLabsTtsProtocol {
  return model.startsWith("eleven_v3") || model.startsWith("eleven_v4") ? "dialogue" : "tts";
}

export function isValidElevenLabsVoiceId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 256 &&
    value !== "." &&
    value !== ".." &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

export function isKnownElevenLabsVoiceId(
  voice: string,
  options: ElevenLabsTtsProviderOptions,
  protocol: ElevenLabsTtsProtocol,
): boolean {
  if (!isValidElevenLabsVoiceId(voice)) return false;
  if (voice === options.voiceId) return true;
  if (protocol === "dialogue") {
    return options.dialogueVoices === undefined || options.dialogueVoices.includes(voice);
  }
  return options.knownVoiceIds === undefined || options.knownVoiceIds.includes(voice);
}

function assertKnownElevenLabsVoice(
  voice: string,
  options: ElevenLabsTtsProviderOptions,
  protocol: ElevenLabsTtsProtocol,
): void {
  assertElevenLabsKnownVoiceIds(options.knownVoiceIds);
  if (!isKnownElevenLabsVoiceId(voice, options, protocol)) {
    throw TvicThrowableError.from(
      providerError(PROVIDER_ERROR_CODES.elevenlabsTts, "ElevenLabs voice is not declared", {
        provider: PROVIDER_NAMES.elevenlabs,
        retriable: false,
      }),
    );
  }
}

export function assertElevenLabsKnownVoiceIds(voiceIds: readonly string[] | undefined): void {
  if (
    voiceIds !== undefined &&
    (!Array.isArray(voiceIds) ||
      voiceIds.length > 100 ||
      new Set(voiceIds).size !== voiceIds.length ||
      !voiceIds.every(isValidElevenLabsVoiceId))
  ) {
    throw elevenLabsOptionError("knownVoiceIds must contain up to 100 unique voice ids");
  }
}

export function elevenLabsTtsSpeedRanges(): readonly ProviderTtsSpeedRange[] {
  return Object.freeze(
    PROVIDER_CATALOG.elevenlabs.models
      .filter((model) => elevenLabsWebSocketProtocol(model) === "tts")
      .map((model) => Object.freeze({ model, ...ELEVENLABS_TTS_SPEED_RANGE })),
  );
}

function assertElevenLabsVoices(voices: readonly string[]): void {
  if (
    !Array.isArray(voices) ||
    voices.length === 0 ||
    voices.length > 10 ||
    new Set(voices).size !== voices.length ||
    !voices.every(
      (voice) =>
        typeof voice === "string" && voice.length > 0 && !/[\u0000-\u001f\u007f]/u.test(voice),
    )
  ) {
    throw elevenLabsOptionError("dialogueVoices must contain one to ten unique voice ids");
  }
}

function assertElevenLabsBoolean(name: string, value: boolean | undefined): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw elevenLabsOptionError(`ElevenLabs ${name} must be a boolean`);
  }
}

function assertElevenLabsSeed(value: number | undefined, protocol: ElevenLabsTtsProtocol): void {
  const minimum = protocol === "dialogue" ? 1 : 0;
  if (
    value !== undefined &&
    (!Number.isInteger(value) || value < minimum || value > 4_294_967_295)
  ) {
    throw elevenLabsOptionError(`ElevenLabs seed must be an integer from ${minimum} to 4294967295`);
  }
}

function assertElevenLabsNormalization(value: ElevenLabsTextNormalization | undefined): void {
  if (value !== undefined && value !== "auto" && value !== "on" && value !== "off") {
    throw elevenLabsOptionError("ElevenLabs applyTextNormalization must be auto, on, or off");
  }
}

function assertElevenLabsInactivityTimeout(value: number | undefined): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 180)) {
    throw elevenLabsOptionError(
      "ElevenLabs inactivityTimeoutSeconds must be an integer from 1 to 180",
    );
  }
}

function assertElevenLabsChunkLengthSchedule(value: readonly number[] | undefined): void {
  if (
    value !== undefined &&
    (!Array.isArray(value) ||
      value.length === 0 ||
      value.length > 20 ||
      !value.every((entry) => Number.isInteger(entry) && entry > 0 && entry <= 10_000))
  ) {
    throw elevenLabsOptionError(
      "ElevenLabs chunkLengthSchedule must contain one to twenty positive thresholds",
    );
  }
}

function assertElevenLabsPronunciationDictionaries(
  value: readonly ElevenLabsPronunciationDictionaryLocator[] | undefined,
): void {
  if (
    value !== undefined &&
    (!Array.isArray(value) ||
      value.length > 3 ||
      !value.every(
        (locator) =>
          locator !== null &&
          typeof locator === "object" &&
          typeof locator.id === "string" &&
          locator.id.length > 0 &&
          !/[\u0000-\u001f\u007f]/u.test(locator.id) &&
          (locator.versionId === undefined ||
            (typeof locator.versionId === "string" &&
              locator.versionId.length > 0 &&
              !/[\u0000-\u001f\u007f]/u.test(locator.versionId))),
      ))
  ) {
    throw elevenLabsOptionError(
      "ElevenLabs pronunciationDictionaryLocators accepts at most three valid locators",
    );
  }
}

function elevenLabsOptionError(message: string): TvicThrowableError {
  return TvicThrowableError.from(
    providerError(PROVIDER_ERROR_CODES.elevenlabsTts, message, {
      provider: PROVIDER_NAMES.elevenlabs,
      retriable: false,
    }),
  );
}

function assertElevenLabsSpeed(value: number | undefined): void {
  if (value === undefined) return;
  if (
    !Number.isFinite(value) ||
    value < ELEVENLABS_TTS_SPEED_RANGE.min ||
    value > ELEVENLABS_TTS_SPEED_RANGE.max
  ) {
    throw elevenLabsSpeedUnsupportedError("ElevenLabs speed is out of range", {
      min: ELEVENLABS_TTS_SPEED_RANGE.min,
      max: ELEVENLABS_TTS_SPEED_RANGE.max,
    });
  }
}

export function elevenLabsLanguageUnsupportedError(
  language: string,
  model: string,
): TvicThrowableError {
  return TvicThrowableError.from(
    validationError(
      TVIC_ERROR_CODES.ttsLanguageUnsupported,
      `ElevenLabs does not support language ${language} for model ${model}`,
      { provider: PROVIDER_NAMES.elevenlabs, metadata: { language, model } },
    ),
  );
}

function elevenLabsSpeedUnsupportedError(
  message: string,
  metadata?: Readonly<Record<string, unknown>>,
): TvicThrowableError {
  return TvicThrowableError.from(
    validationError(TVIC_ERROR_CODES.providerInvalidRequest, message, {
      provider: PROVIDER_NAMES.elevenlabs,
      ...(metadata !== undefined ? { metadata } : {}),
    }),
  );
}

function assertElevenLabsRange(
  name: string,
  value: number | undefined,
  min: number,
  max: number,
): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < min || value > max) {
    throw TvicThrowableError.from(
      providerError(PROVIDER_ERROR_CODES.elevenlabsTts, "ElevenLabs " + name + " is out of range", {
        provider: PROVIDER_NAMES.elevenlabs,
        retriable: false,
        metadata: { name, min, max },
      }),
    );
  }
}
