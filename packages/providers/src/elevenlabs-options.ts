import type WebSocket from "ws";

import { PROVIDER_ERROR_CODES, PROVIDER_NAMES, TvicThrowableError } from "@tvic/core";
import type { TtsSessionOpenRequest } from "@tvic/core";

import { PROVIDER_CATALOG } from "./catalog.js";
import { assertNoUnsupportedTtsTextControls, providerError, type ProviderClock } from "./common.js";

export type ElevenLabsTtsProtocol = "tts" | "dialogue";

export type ElevenLabsTextNormalization = "auto" | "on" | "off";

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

const ELEVENLABS_MULTILINGUAL_V2_LANGUAGES = new Set([
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
const ELEVENLABS_FLASH_V2_5_LANGUAGES = new Set([
  ...ELEVENLABS_MULTILINGUAL_V2_LANGUAGES,
  "hu",
  "no",
  "vi",
]);
const ELEVENLABS_V3_V4_LANGUAGES = new Set([
  "af",
  "ar",
  "hy",
  "as",
  "ast",
  "az",
  "be",
  "bn",
  "bs",
  "bg",
  "my",
  "yue",
  "ca",
  "ceb",
  "ny",
  "hr",
  "cs",
  "da",
  "nl",
  "en",
  "et",
  "fil",
  "fi",
  "fr",
  "gl",
  "ka",
  "de",
  "el",
  "gu",
  "ha",
  "he",
  "hi",
  "hu",
  "is",
  "id",
  "ga",
  "it",
  "ja",
  "jv",
  "kn",
  "kk",
  "ky",
  "ko",
  "lv",
  "ln",
  "lt",
  "lb",
  "mk",
  "ms",
  "ml",
  "mt",
  "zh",
  "mi",
  "mr",
  "mn",
  "ne",
  "no",
  "oc",
  "or",
  "ps",
  "fa",
  "pl",
  "pt",
  "pa",
  "ro",
  "ru",
  "sr",
  "sd",
  "sk",
  "sl",
  "so",
  "es",
  "sw",
  "sv",
  "tg",
  "ta",
  "te",
  "th",
  "tr",
  "uk",
  "ur",
  "uz",
  "vi",
  "cy",
  "yo",
]);
const ELEVENLABS_V3_LANGUAGES = new Set([...ELEVENLABS_V3_V4_LANGUAGES, "ny"]);
const ELEVENLABS_V4_LANGUAGES = ELEVENLABS_V3_V4_LANGUAGES;

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

export function assertElevenLabsRequest(
  request: TtsSessionOpenRequest,
  options: ElevenLabsTtsProviderOptions,
  protocol: ElevenLabsTtsProtocol,
  voice: string,
): void {
  assertNoUnsupportedTtsTextControls(PROVIDER_NAMES.elevenlabs, request);
  const model = request.model ?? options.modelId;
  const language = request.language ?? options.language;
  if (model === "eleven_multilingual_v2" && language !== undefined) {
    throw elevenLabsOptionError("language_code is not supported by eleven_multilingual_v2");
  }
  if (language !== undefined && !supportsElevenLabsTtsLanguage(language, model)) {
    throw elevenLabsOptionError(
      `ElevenLabs does not support language ${language} for model ${model ?? "default"}`,
    );
  }
  if (!isValidElevenLabsVoiceId(voice)) {
    throw TvicThrowableError.from(
      providerError(PROVIDER_ERROR_CODES.elevenlabsTts, "ElevenLabs voice id is invalid", {
        provider: PROVIDER_NAMES.elevenlabs,
        retriable: false,
      }),
    );
  }
  assertElevenLabsRange("speed", request.speed, 0.7, 1.2);
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
  assertElevenLabsSeed(options.seed, protocol);
  assertElevenLabsNormalization(options.applyTextNormalization);
  assertElevenLabsInactivityTimeout(options.inactivityTimeoutSeconds);
  assertElevenLabsChunkLengthSchedule(options.chunkLengthSchedule);
  assertElevenLabsPronunciationDictionaries(options.pronunciationDictionaryLocators);
  if (request.speed !== undefined) {
    const customModelOptIn =
      options.allowUnknownModel === true && model !== undefined && !isElevenLabsCatalogModel(model);
    if (
      protocol === "dialogue" ||
      (!supportsElevenLabsTtsSpeed(request.speed, model) && !customModelOptIn)
    ) {
      throw elevenLabsOptionError("speed is not supported by this ElevenLabs model or route");
    }
  }
  if (
    protocol === "dialogue" &&
    model?.startsWith("eleven_v3") &&
    options.similarityBoost !== undefined
  ) {
    throw elevenLabsOptionError(
      "similarityBoost is not supported by ElevenLabs v3 dialogue models",
    );
  }
  if (options.autoMode === true && options.chunkLengthSchedule !== undefined) {
    throw elevenLabsOptionError("autoMode cannot be combined with chunkLengthSchedule");
  }
  if (options.enableSsmlParsing !== undefined && protocol === "dialogue") {
    throw elevenLabsOptionError("enableSsmlParsing is only supported by regular ElevenLabs TTS");
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

export function supportsElevenLabsTtsLanguage(language: string, model?: string): boolean {
  const code = toElevenLabsLanguageCode(language);
  if (!code || !model || !isElevenLabsCatalogModel(model)) {
    return false;
  }
  if (model === "eleven_multilingual_v2") return false;
  if (model === "eleven_flash_v2_5" || model === "eleven_turbo_v2_5") {
    return ELEVENLABS_FLASH_V2_5_LANGUAGES.has(code);
  }
  if (model === "eleven_flash_v2" || model === "eleven_turbo_v2") return code === "en";
  if (model.startsWith("eleven_v3")) return ELEVENLABS_V3_LANGUAGES.has(code);
  if (model.startsWith("eleven_v4")) return ELEVENLABS_V4_LANGUAGES.has(code);
  return false;
}

export function toElevenLabsLanguageCode(language: string): string | undefined {
  try {
    const [canonical] = Intl.getCanonicalLocales(language);
    return canonical ? new Intl.Locale(canonical).language.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

export function supportsElevenLabsTtsSpeed(speed: number, model?: string): boolean {
  return (
    Number.isFinite(speed) &&
    speed >= 0.7 &&
    speed <= 1.2 &&
    model !== undefined &&
    !model.startsWith("eleven_v3") &&
    !model.startsWith("eleven_v4") &&
    isElevenLabsCatalogModel(model)
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
    typeof value === "string" && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value)
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
