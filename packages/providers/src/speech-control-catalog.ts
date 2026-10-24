import {
  createSpeechControlCatalogSnapshot,
  PROVIDER_NAMES,
  type SpeechControlCatalogSnapshot,
  type SpeechControlFact,
} from "@tvic/core";

import { PROVIDER_API_VERSIONS, PROVIDER_CATALOG } from "./catalog.js";

const CARTESIA_VOICE_SCHEMA_SOURCE = "https://docs.cartesia.ai/api-reference/voices/get";
const CARTESIA_VOICE_SCHEMA_VERIFIED_AT = "2026-10-24";
const CARTESIA_CATALOG_VALIDITY_MS = 24 * 60 * 60 * 1_000;
const MAX_CARTESIA_VOICE_RESPONSE_BYTES = 64 * 1024;
const ELEVENLABS_MODELS_SOURCE = "https://elevenlabs.io/docs/api-reference/models/list";
const ELEVENLABS_VOICES_SOURCE = "https://elevenlabs.io/docs/api-reference/voices/search";
const ELEVENLABS_CATALOG_VERIFIED_AT = "2026-10-25";
const ELEVENLABS_CATALOG_VALIDITY_MS = 24 * 60 * 60 * 1_000;
const MAX_ELEVENLABS_RESPONSE_BYTES = 512 * 1024;
const MAX_ELEVENLABS_MODELS = 512;
const MAX_ELEVENLABS_MODEL_IDS = 32;
const MAX_ELEVENLABS_VOICE_IDS = 32;
const MAX_ELEVENLABS_VOICE_RESULTS = 512;
const MAX_CATALOG_RESPONSE_CHUNKS = 4_096;

export interface LoadCartesiaVoiceControlSnapshotOptions {
  readonly apiKey: string;
  readonly voiceId: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

export interface LoadElevenLabsSpeechControlSnapshotOptions {
  readonly apiKey: string;
  readonly modelIds: readonly string[];
  readonly voiceIds: readonly string[];
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

export async function loadCartesiaVoiceControlSnapshot(
  options: LoadCartesiaVoiceControlSnapshotOptions,
): Promise<SpeechControlCatalogSnapshot> {
  const apiKey = nonEmpty(options.apiKey, "Cartesia API key");
  const voiceId = boundedExternalIdentifier(options.voiceId, "Cartesia voice ID");
  const fetcher = options.fetch ?? fetch;
  const response = await fetcher(`https://api.cartesia.ai/voices/${encodeURIComponent(voiceId)}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Cartesia-Version": PROVIDER_API_VERSIONS.cartesia,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Cartesia voice metadata request failed with HTTP ${response.status}`);
  }

  const metadata = parseVoiceMetadata(
    await readBoundedResponse(
      response,
      MAX_CARTESIA_VOICE_RESPONSE_BYTES,
      "Cartesia voice metadata",
    ),
  );
  if (metadata.id !== voiceId) {
    throw new Error("Cartesia voice metadata response did not match the requested voice ID");
  }

  const now = options.now?.() ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("Cartesia voice catalog clock must return a valid date");
  }
  const fetchedAt = now.getTime();
  const facts: SpeechControlFact[] = PROVIDER_CATALOG.cartesia.models.map((model) => ({
    provider: PROVIDER_NAMES.cartesia,
    control: "tts.voice",
    scope: { type: "account", model, voice: voiceId },
    status: "supported",
    mutability: "call",
    source: CARTESIA_VOICE_SCHEMA_SOURCE,
    verifiedAt: CARTESIA_VOICE_SCHEMA_VERIFIED_AT,
  }));

  if (metadata.isPro !== undefined) {
    for (const model of PROVIDER_CATALOG.cartesia.models) {
      facts.push({
        provider: PROVIDER_NAMES.cartesia,
        control: "tts.speed",
        scope: { type: "account", model, voice: voiceId },
        status: metadata.isPro ? "unsupported" : "supported",
        mutability: "call",
        source: CARTESIA_VOICE_SCHEMA_SOURCE,
        verifiedAt: CARTESIA_VOICE_SCHEMA_VERIFIED_AT,
        ...(!metadata.isPro ? { limits: { min: 0.6, max: 1.5 } } : {}),
      });
    }
  }

  if (metadata.languages !== undefined) {
    for (const model of PROVIDER_CATALOG.cartesia.models) {
      facts.push({
        provider: PROVIDER_NAMES.cartesia,
        control: "tts.language",
        scope: { type: "account", model, voice: voiceId },
        status: "supported",
        mutability: "call",
        source: CARTESIA_VOICE_SCHEMA_SOURCE,
        verifiedAt: CARTESIA_VOICE_SCHEMA_VERIFIED_AT,
        languages: metadata.languages,
      });
    }
  }

  return createSpeechControlCatalogSnapshot(facts, {
    fetchedAt: new Date(fetchedAt).toISOString(),
    validUntil: new Date(fetchedAt + CARTESIA_CATALOG_VALIDITY_MS).toISOString(),
  });
}

export async function loadElevenLabsSpeechControlSnapshot(
  options: LoadElevenLabsSpeechControlSnapshotOptions,
): Promise<SpeechControlCatalogSnapshot> {
  const apiKey = nonEmpty(options.apiKey, "ElevenLabs API key");
  const modelIds = boundedIdentifiers(options.modelIds, MAX_ELEVENLABS_MODEL_IDS, "model IDs");
  const voiceIds = boundedIdentifiers(options.voiceIds, MAX_ELEVENLABS_VOICE_IDS, "voice IDs");
  const fetcher = options.fetch ?? fetch;
  const headers = { "xi-api-key": apiKey, Accept: "application/json" };
  const modelsResponse = await fetcher("https://api.elevenlabs.io/v1/models", {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  const models = parseElevenLabsModels(
    await readJsonResponse(
      modelsResponse,
      MAX_ELEVENLABS_RESPONSE_BYTES,
      "ElevenLabs model catalog",
    ),
  );

  const voicesUrl = new URL("https://api.elevenlabs.io/v2/voices");
  for (const voiceId of voiceIds) voicesUrl.searchParams.append("voice_ids", voiceId);
  voicesUrl.searchParams.set("page_size", "100");
  voicesUrl.searchParams.set("include_total_count", "false");
  const voicesResponse = await fetcher(voicesUrl, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  const voices = parseElevenLabsVoices(
    await readJsonResponse(
      voicesResponse,
      MAX_ELEVENLABS_RESPONSE_BYTES,
      "ElevenLabs voice catalog",
    ),
    new Set(voiceIds),
  );

  const facts: SpeechControlFact[] = [];
  for (const modelId of modelIds) {
    const model = models.get(modelId);
    if (!model) {
      facts.push({
        provider: PROVIDER_NAMES.elevenlabs,
        control: "tts.model",
        scope: { type: "model", model: modelId },
        status: "unsupported",
        mutability: "provider",
        source: ELEVENLABS_MODELS_SOURCE,
        verifiedAt: ELEVENLABS_CATALOG_VERIFIED_AT,
      });
      continue;
    }
    if (model.canDoTextToSpeech === undefined) {
      throw new Error(
        `ElevenLabs model catalog omitted can_do_text_to_speech for requested model ${modelId}`,
      );
    }
    addBooleanModelFact(
      facts,
      "tts.model",
      modelId,
      model.canDoTextToSpeech,
      ELEVENLABS_MODELS_SOURCE,
      model.maxCharacters !== undefined ? { maxCharacters: model.maxCharacters } : undefined,
    );
    addBooleanModelFact(facts, "tts.style", modelId, model.canUseStyle, ELEVENLABS_MODELS_SOURCE);
    addBooleanModelFact(
      facts,
      "tts.speaker_boost",
      modelId,
      model.canUseSpeakerBoost,
      ELEVENLABS_MODELS_SOURCE,
    );
    addBooleanModelFact(
      facts,
      "tts.pro_voice",
      modelId,
      model.servesProVoices,
      ELEVENLABS_MODELS_SOURCE,
    );
    if (model.canDoTextToSpeech !== true) continue;
    for (const voiceId of voiceIds) {
      const voice = voices.get(voiceId);
      if (!voice) continue;
      const languages = voice.languagesByModel.get(modelId);
      if (languages?.length) {
        facts.push({
          provider: PROVIDER_NAMES.elevenlabs,
          control: "tts.language",
          scope: { type: "account", model: modelId, voice: voiceId },
          status: "supported",
          mutability: "call",
          source: ELEVENLABS_VOICES_SOURCE,
          verifiedAt: ELEVENLABS_CATALOG_VERIFIED_AT,
          languages,
        });
      }
    }
  }

  for (const voiceId of voiceIds) {
    const voice = voices.get(voiceId);
    if (!voice || voice.category === undefined) continue;
    if (voice.category === "professional") {
      for (const modelId of modelIds) {
        const model = models.get(modelId);
        if (model?.canDoTextToSpeech !== true || model.servesProVoices === undefined) continue;
        facts.push({
          provider: PROVIDER_NAMES.elevenlabs,
          control: "tts.voice",
          scope: { type: "account", model: modelId, voice: voiceId },
          status: model.servesProVoices ? "supported" : "unsupported",
          mutability: "provider",
          source: ELEVENLABS_VOICES_SOURCE,
          verifiedAt: ELEVENLABS_CATALOG_VERIFIED_AT,
        });
      }
      continue;
    }
    facts.push({
      provider: PROVIDER_NAMES.elevenlabs,
      control: "tts.voice",
      scope: { type: "account", voice: voiceId },
      status: "supported",
      mutability: "provider",
      source: ELEVENLABS_VOICES_SOURCE,
      verifiedAt: ELEVENLABS_CATALOG_VERIFIED_AT,
    });
  }

  const now = options.now?.() ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("ElevenLabs speech control catalog clock must return a valid date");
  }
  const fetchedAt = now.getTime();
  return createSpeechControlCatalogSnapshot(facts, {
    fetchedAt: new Date(fetchedAt).toISOString(),
    validUntil: new Date(fetchedAt + ELEVENLABS_CATALOG_VALIDITY_MS).toISOString(),
  });
}

async function readBoundedResponse(
  response: Response,
  maxBytes: number,
  label: string,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`${label} response body is missing`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  let chunkCount = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunkCount += 1;
      if (chunkCount > MAX_CATALOG_RESPONSE_CHUNKS) {
        await reader.cancel();
        throw new Error(`${label} response exceeded the fragment limit`);
      }
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error(`${label} response exceeded the size limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function readJsonResponse(
  response: Response,
  maxBytes: number,
  label: string,
): Promise<unknown> {
  if (!response.ok) throw new Error(`${label} request failed with HTTP ${response.status}`);
  const body = await readBoundedResponse(response, maxBytes, label);
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error(`${label} response was not valid JSON`);
  }
}

interface ElevenLabsModelFacts {
  readonly canDoTextToSpeech?: boolean;
  readonly canUseStyle?: boolean;
  readonly canUseSpeakerBoost?: boolean;
  readonly servesProVoices?: boolean;
  readonly maxCharacters?: number;
}

interface ElevenLabsVoiceFacts {
  readonly category?: "premade" | "cloned" | "generated" | "professional";
  readonly languagesByModel: ReadonlyMap<string, readonly string[]>;
}

function parseElevenLabsModels(value: unknown): ReadonlyMap<string, ElevenLabsModelFacts> {
  if (!Array.isArray(value) || value.length > MAX_ELEVENLABS_MODELS) {
    throw new Error("ElevenLabs model catalog response has an invalid model list");
  }
  const models = new Map<string, ElevenLabsModelFacts>();
  for (const item of value) {
    if (!isRecord(item) || !isValidExternalIdentifier(item.model_id)) {
      throw new Error("ElevenLabs model catalog response contains an invalid model ID");
    }
    if (models.has(item.model_id))
      throw new Error("ElevenLabs model catalog contains a duplicate model ID");
    const maxCharacters = item.maximum_text_length_per_request;
    if (
      maxCharacters !== undefined &&
      (typeof maxCharacters !== "number" ||
        !Number.isSafeInteger(maxCharacters) ||
        maxCharacters < 1)
    ) {
      throw new Error("ElevenLabs model catalog response contains an invalid character limit");
    }
    const canDoTextToSpeech = optionalBoolean(item, "can_do_text_to_speech");
    const canUseStyle = optionalBoolean(item, "can_use_style");
    const canUseSpeakerBoost = optionalBoolean(item, "can_use_speaker_boost");
    const servesProVoices = optionalBoolean(item, "serves_pro_voices");
    models.set(item.model_id, {
      ...(canDoTextToSpeech !== undefined ? { canDoTextToSpeech } : {}),
      ...(canUseStyle !== undefined ? { canUseStyle } : {}),
      ...(canUseSpeakerBoost !== undefined ? { canUseSpeakerBoost } : {}),
      ...(servesProVoices !== undefined ? { servesProVoices } : {}),
      ...(maxCharacters !== undefined ? { maxCharacters } : {}),
    });
  }
  return models;
}

function parseElevenLabsVoices(
  value: unknown,
  requestedVoiceIds: ReadonlySet<string>,
): ReadonlyMap<string, ElevenLabsVoiceFacts> {
  if (
    !isRecord(value) ||
    !Array.isArray(value.voices) ||
    value.voices.length > MAX_ELEVENLABS_VOICE_RESULTS
  ) {
    throw new Error("ElevenLabs voice catalog response has an invalid voice list");
  }
  const voices = new Map<string, ElevenLabsVoiceFacts>();
  for (const item of value.voices) {
    if (!isRecord(item) || !isValidExternalIdentifier(item.voice_id)) {
      throw new Error("ElevenLabs voice catalog response contains an unexpected voice ID");
    }
    if (!requestedVoiceIds.has(item.voice_id)) continue;
    if (voices.has(item.voice_id))
      throw new Error("ElevenLabs voice catalog contains a duplicate voice ID");
    const category = parseElevenLabsVoiceCategory(item.category);
    const languagesByModel = parseElevenLabsVoiceLanguages(item.verified_languages);
    voices.set(item.voice_id, {
      ...(category !== undefined ? { category } : {}),
      languagesByModel,
    });
  }
  return voices;
}

function parseElevenLabsVoiceCategory(
  value: unknown,
): ElevenLabsVoiceFacts["category"] | undefined {
  if (value === undefined) return undefined;
  if (
    value === "premade" ||
    value === "cloned" ||
    value === "generated" ||
    value === "professional"
  ) {
    return value;
  }
  throw new Error("ElevenLabs voice catalog response contains an invalid voice category");
}

function parseElevenLabsVoiceLanguages(value: unknown): ReadonlyMap<string, readonly string[]> {
  if (value === undefined || value === null) return new Map();
  if (!Array.isArray(value) || value.length > 128) {
    throw new Error("ElevenLabs voice catalog response has invalid verified languages");
  }
  const byModel = new Map<string, Set<string>>();
  for (const item of value) {
    if (!isRecord(item) || !isValidExternalIdentifier(item.model_id)) {
      throw new Error("ElevenLabs voice catalog response contains an invalid verified language");
    }
    const locale = item.locale ?? item.language;
    if (typeof locale !== "string") {
      throw new Error(
        "ElevenLabs voice catalog response contains a verified language without a locale",
      );
    }
    let canonical: string | undefined;
    try {
      canonical = Intl.getCanonicalLocales(locale)[0];
    } catch {
      canonical = undefined;
    }
    if (!canonical)
      throw new Error("ElevenLabs voice catalog response contains an invalid language locale");
    const languages = byModel.get(item.model_id) ?? new Set<string>();
    languages.add(canonical);
    byModel.set(item.model_id, languages);
  }
  return new Map(
    [...byModel].map(([modelId, languages]) => [modelId, Object.freeze([...languages])]),
  );
}

function addBooleanModelFact(
  facts: SpeechControlFact[],
  control: string,
  model: string,
  supported: boolean | undefined,
  source: string,
  limits?: Readonly<Record<string, number | string | boolean>>,
): void {
  if (supported === undefined) return;
  facts.push({
    provider: PROVIDER_NAMES.elevenlabs,
    control,
    scope: { type: "model", model },
    status: supported ? "supported" : "unsupported",
    mutability: "call",
    source,
    verifiedAt: ELEVENLABS_CATALOG_VERIFIED_AT,
    ...(limits !== undefined ? { limits } : {}),
  });
}

function optionalBoolean(value: Record<string, unknown>, key: string): boolean | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== "boolean")
    throw new Error(`ElevenLabs model catalog response has invalid ${key}`);
  return field;
}

function boundedIdentifiers(
  value: readonly string[],
  max: number,
  label: string,
): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) {
    throw new TypeError(`ElevenLabs ${label} must contain between 1 and ${max} identifiers`);
  }
  const identifiers = value.map((item) => {
    if (!isValidExternalIdentifier(item)) {
      throw new TypeError(`ElevenLabs ${label} contain an invalid identifier`);
    }
    return item;
  });
  if (new Set(identifiers).size !== identifiers.length) {
    throw new TypeError(`ElevenLabs ${label} must be unique`);
  }
  return identifiers;
}

function isValidExternalIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= 128 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function parseVoiceMetadata(value: string): {
  readonly id: string;
  readonly isPro?: boolean;
  readonly languages?: readonly string[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Cartesia voice metadata response was not valid JSON");
  }
  if (!isRecord(parsed) || typeof parsed.id !== "string") {
    throw new Error("Cartesia voice metadata response was missing the voice ID");
  }
  const languages = parseLanguages(parsed.accents);
  return {
    id: parsed.id,
    ...(typeof parsed.is_pro === "boolean" ? { isPro: parsed.is_pro } : {}),
    ...(languages !== undefined ? { languages } : {}),
  };
}

function parseLanguages(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const languages = new Set<string>();
  for (const accent of value) {
    if (!isRecord(accent) || typeof accent.locale !== "string") return undefined;
    try {
      const [language] = Intl.getCanonicalLocales(accent.locale);
      if (!language) return undefined;
      languages.add(language);
    } catch {
      return undefined;
    }
  }
  return Object.freeze([...languages]);
}

function nonEmpty(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be non-empty`);
  }
  return value.trim();
}

function boundedExternalIdentifier(value: string, label: string): string {
  const identifier = nonEmpty(value, label);
  if (!isValidExternalIdentifier(identifier)) {
    throw new TypeError(`${label} must be a valid identifier of at most 128 characters`);
  }
  return identifier;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
