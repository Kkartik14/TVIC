import type WebSocket from "ws";

import {
  PROVIDER_CAPABILITY_FEATURES,
  PROVIDER_ERROR_CODES,
  PROVIDER_NAMES,
  TvicThrowableError,
  resolveProviderCapability,
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
  protocol = elevenLabsTtsProtocol(modelId),
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
>;

export function assertElevenLabsRequest(
  request: TtsSessionOpenRequest,
  options: ElevenLabsTtsProviderOptions,
  protocol: ElevenLabsTtsProtocol,
  voice: string,
  additionalVoices: readonly string[] = [],
): void {
  assertElevenLabsLanguageSetting(
    options,
    request.model ?? options.modelId ?? PROVIDER_CATALOG.elevenlabs.defaultModel,
    protocol,
  );
  if (typeof voice !== "string" || voice.length === 0 || /[\u0000-\u001f\u007f]/u.test(voice)) {
    throw TvicThrowableError.from(
      providerError(PROVIDER_ERROR_CODES.elevenlabsTts, "ElevenLabs voice id is invalid", {
        provider: PROVIDER_NAMES.elevenlabs,
        retriable: false,
      }),
    );
  }
  assertElevenLabsRange(
    "speed",
    request.speed,
    ELEVENLABS_TTS_SPEED_RANGE.min,
    ELEVENLABS_TTS_SPEED_RANGE.max,
  );
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
  assertElevenLabsConfiguredModelOptions(options, protocol);
  assertElevenLabsCapabilityRequirements(
    request,
    options,
    request.model ?? options.modelId ?? PROVIDER_CATALOG.elevenlabs.defaultModel,
    voice,
    additionalVoices,
    protocol,
  );
  if (protocol === "dialogue" && request.speed !== undefined) {
    throw elevenLabsOptionError("speed is not supported by ElevenLabs v3 dialogue models");
  }
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

  if (hasSnapshots && options.language !== undefined && protocol === "tts") {
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
        (locale) => typeof locale === "string" && matchesLocale(options.language!, locale),
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
  let resolution = resolveProviderCapability(snapshots, query, evaluationTimeMs);
  if (resolution.status !== "unknown" || resolution.reason !== "fact_missing") {
    if (resolution.status !== "supported") {
      throw capabilitySnapshotError(
        `ElevenLabs cannot use voice ${voice}: capability snapshot is ${capabilityState(resolution)} for model ${model}`,
      );
    }
    return;
  }

  const category = resolveProviderCapability(
    snapshots,
    {
      provider: PROVIDER_NAMES.elevenlabs,
      feature: ELEVENLABS_CAPABILITY_FEATURES.ttsVoiceCategory,
      scope: "voice",
      voice,
    },
    evaluationTimeMs,
  );
  if (
    category.status === "supported" &&
    (category.value === "premade" || category.value === "cloned" || category.value === "generated")
  ) {
    resolution = resolveProviderCapability(
      snapshots,
      {
        provider: PROVIDER_NAMES.elevenlabs,
        feature: PROVIDER_CAPABILITY_FEATURES.ttsVoiceAvailable,
        scope: "voice",
        voice,
      },
      evaluationTimeMs,
    );
    if (resolution.status === "supported") return;
  }

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
    const protocol = elevenLabsTtsProtocol(model);
    assertElevenLabsLanguageSetting(options, model, protocol);
    assertElevenLabsConfiguredModelOptions(options, protocol);
    return true;
  } catch {
    return false;
  }
}

function assertElevenLabsConfiguredModelOptions(
  options: ElevenLabsModelSelectionOptions,
  protocol: ElevenLabsTtsProtocol,
): void {
  assertElevenLabsSsmlSetting(options, protocol);
  assertElevenLabsSeed(options.seed, protocol);
  if (protocol === "dialogue" && options.similarityBoost !== undefined) {
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
    throw elevenLabsOptionError("dialogueVoices requires an ElevenLabs v3 dialogue model");
  }
}

export function assertElevenLabsLanguageSetting(
  options: Pick<ElevenLabsTtsProviderOptions, "language">,
  model: string,
  protocol: ElevenLabsTtsProtocol,
): void {
  if (options.language === undefined) return;
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
): void {
  if (options.enableSsmlParsing === true) {
    throw elevenLabsOptionError("SSML parsing is disabled for caller-influenced TTS text");
  }
  if (options.enableSsmlParsing !== undefined && protocol === "dialogue") {
    throw elevenLabsOptionError("enableSsmlParsing is only supported by regular ElevenLabs TTS");
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

export function elevenLabsTtsProtocol(model: string): ElevenLabsTtsProtocol {
  return model.startsWith("eleven_v3") ? "dialogue" : "tts";
}

export function elevenLabsTtsSpeedRanges(): readonly ProviderTtsSpeedRange[] {
  return Object.freeze(
    PROVIDER_CATALOG.elevenlabs.models
      .filter((model) => elevenLabsTtsProtocol(model) === "tts")
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
