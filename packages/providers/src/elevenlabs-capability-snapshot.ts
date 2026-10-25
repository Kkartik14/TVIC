import {
  createProviderCapabilitySnapshot,
  PROVIDER_CAPABILITY_FEATURES,
  PROVIDER_NAMES,
  TVIC_ERROR_CODES,
} from "@tvic/core";
import type { ProviderCapabilityFact, ProviderCapabilitySnapshot } from "@tvic/core";

import { PROVIDER_CATALOG } from "./catalog.js";
import { providerError, readBoundedResponseText } from "./common.js";

export const MAX_ELEVENLABS_SNAPSHOT_MODEL_IDS = 16;
export const MAX_ELEVENLABS_SNAPSHOT_VOICE_IDS = 100;
export const MAX_ELEVENLABS_SNAPSHOT_VOICE_MODEL_PAIRS = 128;
export const MAX_ELEVENLABS_SNAPSHOT_RESPONSE_BYTES = 2_000_000;

export interface LoadElevenLabsCapabilitySnapshotOptions {
  readonly apiKey: string;
  readonly modelIds?: readonly string[];
  readonly voiceIds?: readonly string[];
  readonly forcedNormalizationModelIds?: readonly string[];
  readonly validUntil: string;
  readonly fetchedAt?: string;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
}

const ELEVENLABS_SOURCE = "https://elevenlabs.io/docs/api-reference/models/list";
const ELEVENLABS_API_BASE = "https://api.elevenlabs.io";
const ELEVENLABS_VOICE_CATEGORIES = new Set(["premade", "cloned", "generated", "professional"]);
const ELEVENLABS_PUBLIC_TIERS = new Set(["free", "starter", "creator", "pro", "scale", "business"]);
type JsonObject = Readonly<Record<string, unknown>>;

interface VoiceCatalogPage {
  readonly complete: boolean;
  readonly records: ReadonlyMap<string, JsonObject>;
}

export async function loadElevenLabsCapabilitySnapshot(
  options: LoadElevenLabsCapabilitySnapshotOptions,
): Promise<ProviderCapabilitySnapshot> {
  const request = validateOptions(options);
  const snapshotMetadata = createProviderCapabilitySnapshot({
    provider: PROVIDER_NAMES.elevenlabs,
    source: ELEVENLABS_SOURCE,
    fetchedAt: options.fetchedAt ?? new Date().toISOString(),
    validUntil: options.validUntil,
    facts: [],
  });
  const fetchImpl = options.fetchImpl ?? fetch;
  const facts: ProviderCapabilityFact[] = [];
  const modelRecords =
    request.modelIds.length > 0
      ? await loadModels(fetchImpl, options.apiKey, options.signal)
      : new Map<string, JsonObject>();
  const voiceRecords =
    request.voiceIds.length > 0
      ? await loadVoices(fetchImpl, options.apiKey, request.voiceIds, options.signal)
      : { complete: true, records: new Map<string, JsonObject>() };

  for (const modelId of request.modelIds) {
    const model = modelRecords.get(modelId);
    facts.push({
      feature: PROVIDER_CAPABILITY_FEATURES.ttsModelAvailable,
      scope: "model",
      model: modelId,
      status: model ? "supported" : "unsupported",
    });
    facts.push(
      readBooleanModelFact(
        PROVIDER_CAPABILITY_FEATURES.ttsModelCanDoTextToSpeech,
        modelId,
        model?.can_do_text_to_speech,
      ),
    );
    facts.push(
      readBooleanModelFact(
        PROVIDER_CAPABILITY_FEATURES.ttsModelCanUseStyle,
        modelId,
        model?.can_use_style,
      ),
    );
    facts.push(
      readBooleanModelFact(
        PROVIDER_CAPABILITY_FEATURES.ttsModelCanUseSpeakerBoost,
        modelId,
        model?.can_use_speaker_boost,
      ),
    );
    facts.push(
      readBooleanModelFact(
        PROVIDER_CAPABILITY_FEATURES.ttsModelServesProfessionalVoices,
        modelId,
        model?.serves_pro_voices,
      ),
    );
  }

  for (const voiceId of request.voiceIds) {
    const voice = voiceRecords.records.get(voiceId);
    const category = readVoiceCategory(voice?.category);
    facts.push({
      feature: PROVIDER_CAPABILITY_FEATURES.ttsVoiceCategory,
      scope: "voice",
      voice: voiceId,
      ...category,
    });
    for (const modelId of request.modelIds) {
      facts.push(
        readVoiceAvailabilityFact(
          voiceId,
          modelId,
          voice,
          voiceRecords.complete,
          category,
          modelRecords.get(modelId),
        ),
      );
      facts.push(readVerifiedLocalesFact(voiceId, modelId, voice?.verified_languages));
    }
  }

  if (request.forcedNormalizationModelIds.length > 0) {
    const subscription = await loadSubscription(fetchImpl, options.apiKey, options.signal);
    facts.push(readForcedNormalizationFact(subscription.tier));
  }

  return createProviderCapabilitySnapshot({ ...snapshotMetadata, facts });
}

function validateOptions(options: LoadElevenLabsCapabilitySnapshotOptions): {
  readonly modelIds: readonly string[];
  readonly voiceIds: readonly string[];
  readonly forcedNormalizationModelIds: readonly string[];
} {
  if (typeof options.apiKey !== "string" || options.apiKey.trim().length === 0) {
    throw new TypeError("ElevenLabs capability snapshot API key is required");
  }
  const modelIds = validateIds(options.modelIds ?? [], "model", MAX_ELEVENLABS_SNAPSHOT_MODEL_IDS);
  const voiceIds = validateIds(options.voiceIds ?? [], "voice", MAX_ELEVENLABS_SNAPSHOT_VOICE_IDS);
  const forcedNormalizationModelIds = validateIds(
    options.forcedNormalizationModelIds ?? [],
    "forced-normalization model",
    MAX_ELEVENLABS_SNAPSHOT_MODEL_IDS,
  );
  if (modelIds.length === 0 && voiceIds.length === 0) {
    throw new RangeError("ElevenLabs capability snapshot requires a model ID or voice ID");
  }
  if (modelIds.length * voiceIds.length > MAX_ELEVENLABS_SNAPSHOT_VOICE_MODEL_PAIRS) {
    throw new RangeError(
      `ElevenLabs capability snapshot supports at most ${MAX_ELEVENLABS_SNAPSHOT_VOICE_MODEL_PAIRS} voice/model pairs`,
    );
  }
  for (const modelId of forcedNormalizationModelIds) {
    if (
      !modelIds.includes(modelId) ||
      !PROVIDER_CATALOG.elevenlabs.forcedNormalizationModels?.some((model) => model === modelId)
    ) {
      throw new TypeError(
        "ElevenLabs forced normalization snapshots require requested Flash/Turbo v2.5 models",
      );
    }
  }
  return { modelIds, voiceIds, forcedNormalizationModelIds };
}

function validateIds(values: readonly string[], name: string, maximum: number): readonly string[] {
  if (!Array.isArray(values)) throw new TypeError(`ElevenLabs ${name} IDs must be an array`);
  if (values.length > maximum) {
    throw new RangeError(`ElevenLabs capability snapshot supports at most ${maximum} ${name} IDs`);
  }
  const seen = new Set<string>();
  for (const value of values) {
    if (
      typeof value !== "string" ||
      value.trim().length === 0 ||
      value.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(value)
    ) {
      throw new TypeError(`ElevenLabs ${name} ID is invalid`);
    }
    if (seen.has(value)) throw new TypeError(`ElevenLabs ${name} IDs must be unique`);
    seen.add(value);
  }
  return values;
}

async function loadModels(
  fetchImpl: typeof fetch,
  apiKey: string,
  signal: AbortSignal | undefined,
): Promise<ReadonlyMap<string, JsonObject>> {
  const payload = await requestJson(fetchImpl, `${ELEVENLABS_API_BASE}/v1/models`, apiKey, signal);
  if (!Array.isArray(payload) || payload.length > 512) {
    throw invalidResponse("model catalog");
  }
  const records = new Map<string, JsonObject>();
  for (const candidate of payload) {
    const record = asRecord(candidate);
    if (!record || typeof record.model_id !== "string" || record.model_id.length === 0) {
      throw invalidResponse("model catalog");
    }
    if (records.has(record.model_id)) throw invalidResponse("model catalog");
    records.set(record.model_id, record);
  }
  return records;
}

async function loadVoices(
  fetchImpl: typeof fetch,
  apiKey: string,
  voiceIds: readonly string[],
  signal: AbortSignal | undefined,
): Promise<VoiceCatalogPage> {
  const url = new URL(`${ELEVENLABS_API_BASE}/v2/voices`);
  url.searchParams.set("page_size", String(MAX_ELEVENLABS_SNAPSHOT_VOICE_IDS));
  for (const voiceId of voiceIds) url.searchParams.append("voice_ids", voiceId);
  const payload = await requestJson(fetchImpl, url.toString(), apiKey, signal);
  const body = asRecord(payload);
  if (
    !body ||
    !Array.isArray(body.voices) ||
    body.voices.length > MAX_ELEVENLABS_SNAPSHOT_VOICE_IDS
  ) {
    throw invalidResponse("voice catalog");
  }
  if (body.has_more !== undefined && typeof body.has_more !== "boolean") {
    throw invalidResponse("voice catalog");
  }
  const records = new Map<string, JsonObject>();
  for (const candidate of body.voices) {
    const record = asRecord(candidate);
    if (!record || typeof record.voice_id !== "string" || record.voice_id.length === 0) {
      throw invalidResponse("voice catalog");
    }
    if (records.has(record.voice_id)) throw invalidResponse("voice catalog");
    records.set(record.voice_id, record);
  }
  return { complete: body.has_more === false, records };
}

async function loadSubscription(
  fetchImpl: typeof fetch,
  apiKey: string,
  signal: AbortSignal | undefined,
): Promise<JsonObject> {
  const payload = await requestJson(
    fetchImpl,
    `${ELEVENLABS_API_BASE}/v1/user/subscription`,
    apiKey,
    signal,
  );
  const body = asRecord(payload);
  if (!body) throw invalidResponse("subscription");
  return body;
}

async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  apiKey: string,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { "xi-api-key": apiKey },
      ...(signal ? { signal } : {}),
    });
  } catch {
    throw providerError(
      TVIC_ERROR_CODES.providerUpstreamFailed,
      "ElevenLabs capability snapshot request failed",
      { provider: PROVIDER_NAMES.elevenlabs, retriable: true },
    );
  }
  if (!response.ok) {
    throw elevenLabsCapabilityRequestError(response.status);
  }
  let text: string;
  try {
    text = await readBoundedResponseText(response, MAX_ELEVENLABS_SNAPSHOT_RESPONSE_BYTES);
  } catch {
    throw invalidResponse("provider");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidResponse("provider");
  }
}

function elevenLabsCapabilityRequestError(status: number) {
  const message = `ElevenLabs capability snapshot request failed with HTTP ${status}`;
  const metadata = { httpStatus: status };
  if (status === 401 || status === 403) {
    return providerError(TVIC_ERROR_CODES.providerAuthFailed, message, {
      provider: PROVIDER_NAMES.elevenlabs,
      retriable: false,
      metadata,
    });
  }
  if (status === 402) {
    return providerError(TVIC_ERROR_CODES.providerQuotaExceeded, message, {
      provider: PROVIDER_NAMES.elevenlabs,
      retriable: false,
      metadata,
    });
  }
  if (status === 429) {
    return providerError(TVIC_ERROR_CODES.providerRateLimited, message, {
      provider: PROVIDER_NAMES.elevenlabs,
      retriable: true,
      metadata,
    });
  }
  if (status >= 500) {
    return providerError(TVIC_ERROR_CODES.providerUpstreamFailed, message, {
      provider: PROVIDER_NAMES.elevenlabs,
      retriable: true,
      metadata,
    });
  }
  return providerError(TVIC_ERROR_CODES.providerInvalidRequest, message, {
    provider: PROVIDER_NAMES.elevenlabs,
    retriable: false,
    metadata,
  });
}

function readBooleanModelFact(
  feature: string,
  model: string,
  value: unknown,
): ProviderCapabilityFact {
  return typeof value === "boolean"
    ? {
        feature,
        scope: "model",
        model,
        status:
          feature === PROVIDER_CAPABILITY_FEATURES.ttsModelCanDoTextToSpeech && !value
            ? "unsupported"
            : "supported",
        value,
      }
    : { feature, scope: "model", model, status: "unknown" };
}

function readVoiceCategory(value: unknown): {
  readonly status: "supported" | "unknown";
  readonly value?: string;
} {
  return typeof value === "string" && ELEVENLABS_VOICE_CATEGORIES.has(value)
    ? { status: "supported", value }
    : { status: "unknown" };
}

function readVoiceAvailabilityFact(
  voice: string,
  model: string,
  voiceRecord: JsonObject | undefined,
  voiceCatalogComplete: boolean,
  category: ReturnType<typeof readVoiceCategory>,
  modelRecord: JsonObject | undefined,
): ProviderCapabilityFact {
  let status: ProviderCapabilityFact["status"];
  if (!voiceRecord) status = voiceCatalogComplete ? "unsupported" : "unknown";
  else if (!modelRecord) status = "unsupported";
  else if (category.status === "unknown") status = "unknown";
  else if (category.value !== "professional") status = "supported";
  else if (typeof modelRecord.serves_pro_voices !== "boolean") status = "unknown";
  else status = modelRecord.serves_pro_voices ? "supported" : "unsupported";
  return {
    feature: PROVIDER_CAPABILITY_FEATURES.ttsVoiceAvailable,
    scope: "voice",
    model,
    voice,
    status,
  };
}

function readVerifiedLocalesFact(
  voice: string,
  model: string,
  value: unknown,
): ProviderCapabilityFact {
  const unknownFact: ProviderCapabilityFact = {
    feature: PROVIDER_CAPABILITY_FEATURES.ttsVoiceVerifiedLocales,
    scope: "voice",
    model,
    voice,
    status: "unknown",
  };
  if (!Array.isArray(value) || value.length > 64) return unknownFact;
  const languages = value.map(readVerifiedLanguage);
  if (languages.some((language) => language === undefined)) return unknownFact;
  const matching = languages.filter(
    (language): language is VerifiedLanguage =>
      language !== undefined && language.modelId === model,
  );
  if (matching.length === 0) return unknownFact;
  return {
    ...unknownFact,
    status: "supported",
    value: [...new Set(matching.map((language) => language.locale))],
  };
}

interface VerifiedLanguage {
  readonly modelId: string;
  readonly locale: string;
}

function readVerifiedLanguage(value: unknown): VerifiedLanguage | undefined {
  const record = asRecord(value);
  if (
    !record ||
    typeof record.model_id !== "string" ||
    record.model_id.length === 0 ||
    typeof record.locale !== "string" ||
    record.locale.length === 0
  ) {
    return undefined;
  }
  return { modelId: record.model_id, locale: record.locale };
}

function readForcedNormalizationFact(tier: unknown): ProviderCapabilityFact {
  const status =
    tier === "enterprise"
      ? "supported"
      : typeof tier === "string" && ELEVENLABS_PUBLIC_TIERS.has(tier)
        ? "unsupported"
        : "unknown";
  return {
    feature: PROVIDER_CAPABILITY_FEATURES.ttsForcedNormalization,
    scope: "account",
    status,
  };
}

function asRecord(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function invalidResponse(name: string) {
  return providerError(
    TVIC_ERROR_CODES.providerProtocolInvalid,
    `ElevenLabs returned an invalid ${name} capability response`,
    { provider: PROVIDER_NAMES.elevenlabs, retriable: false },
  );
}
