import {
  createProviderCapabilitySnapshot,
  MAX_PROVIDER_CAPABILITY_VALUE_ITEMS,
  PROVIDER_CAPABILITY_FEATURES,
  PROVIDER_NAMES,
  TVIC_ERROR_CODES,
} from "@tvic/core";
import type { ProviderCapabilityFact, ProviderCapabilitySnapshot } from "@tvic/core";

import { PROVIDER_API_VERSIONS, PROVIDER_CATALOG } from "./catalog.js";
import { providerConnectionCancelled, providerError, readBoundedResponseText } from "./common.js";

export const MAX_CARTESIA_SNAPSHOT_VOICE_IDS = 100;
export const MAX_CARTESIA_SNAPSHOT_MODEL_IDS = 16;
export const MAX_CARTESIA_SNAPSHOT_VOICE_MODEL_PAIRS = 128;
export const MAX_CARTESIA_SNAPSHOT_RESPONSE_BYTES = 2_000_000;
const CARTESIA_SNAPSHOT_CONCURRENT_REQUESTS = 4;

export interface LoadCartesiaCapabilitySnapshotOptions {
  readonly apiKey: string;
  readonly voiceIds: readonly string[];
  readonly modelIds: readonly string[];
  readonly validUntil: string;
  readonly fetchedAt?: string;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
}

const CARTESIA_VOICE_SOURCE = "https://docs.cartesia.ai/api-reference/voices/get";

export async function loadCartesiaCapabilitySnapshot(
  options: LoadCartesiaCapabilitySnapshotOptions,
): Promise<ProviderCapabilitySnapshot> {
  const { modelIds, voiceIds } = validateOptions(options);
  const snapshotMetadata = createProviderCapabilitySnapshot({
    provider: PROVIDER_NAMES.cartesia,
    source: CARTESIA_VOICE_SOURCE,
    fetchedAt: options.fetchedAt ?? new Date().toISOString(),
    validUntil: options.validUntil,
    facts: [],
  });
  const fetchImpl = options.fetchImpl ?? fetch;
  const facts: ProviderCapabilityFact[] = [];
  const loadedVoices: { readonly voiceId: string; readonly payload: Readonly<Record<string, unknown>> }[] =
    [];

  for (let offset = 0; offset < voiceIds.length; offset += CARTESIA_SNAPSHOT_CONCURRENT_REQUESTS) {
    const batch = voiceIds.slice(offset, offset + CARTESIA_SNAPSHOT_CONCURRENT_REQUESTS);
    const results = await Promise.allSettled(
      batch.map(async (voiceId) => {
        const response = await requestVoice(fetchImpl, options.apiKey, voiceId, options.signal);
        const payload = await readVoicePayload(response, options.signal);
        if (payload.id !== voiceId) {
          throw providerError(
            TVIC_ERROR_CODES.providerProtocolInvalid,
            "Cartesia voice response did not match the requested voice",
            { provider: PROVIDER_NAMES.cartesia, retriable: false },
          );
        }
        return { voiceId, payload };
      }),
    );
    const rejected = results.find((result) => result.status === "rejected");
    if (rejected?.status === "rejected") {
      throw rejected.reason;
    }
    for (const result of results) {
      if (result.status === "fulfilled") loadedVoices.push(result.value);
    }
  }

  for (const { voiceId, payload } of loadedVoices) {
    for (const model of modelIds) {
      facts.push({
        feature: PROVIDER_CAPABILITY_FEATURES.ttsVoiceAvailable,
        scope: "voice",
        model,
        voice: voiceId,
        status: !PROVIDER_CATALOG.cartesia.models.some((catalogModel) => catalogModel === model)
          ? "unknown"
          : payload.status === "active"
            ? "supported"
            : payload.status === "archived"
              ? "unsupported"
              : "unknown",
      });
    }
    facts.push(
      readBooleanFact(PROVIDER_CAPABILITY_FEATURES.ttsVoiceIsPro, voiceId, payload.is_pro),
    );
    facts.push(readAccentLocalesFact(voiceId, payload.accents));
  }

  return createProviderCapabilitySnapshot({
    ...snapshotMetadata,
    facts,
  });
}

function validateOptions(options: LoadCartesiaCapabilitySnapshotOptions): {
  readonly modelIds: readonly string[];
  readonly voiceIds: readonly string[];
} {
  if (typeof options.apiKey !== "string" || options.apiKey.trim().length === 0) {
    throw new TypeError("Cartesia capability snapshot API key is required");
  }
  if (!Array.isArray(options.voiceIds) || options.voiceIds.length === 0) {
    throw new RangeError("Cartesia capability snapshot requires at least one voice ID");
  }
  if (options.voiceIds.length > MAX_CARTESIA_SNAPSHOT_VOICE_IDS) {
    throw new RangeError(
      `Cartesia capability snapshot supports at most ${MAX_CARTESIA_SNAPSHOT_VOICE_IDS} voice IDs`,
    );
  }
  if (
    !Array.isArray(options.modelIds) ||
    options.modelIds.length === 0 ||
    options.modelIds.length > MAX_CARTESIA_SNAPSHOT_MODEL_IDS
  ) {
    throw new RangeError(
      `Cartesia capability snapshot requires 1 to ${MAX_CARTESIA_SNAPSHOT_MODEL_IDS} model IDs`,
    );
  }
  if (options.modelIds.length * options.voiceIds.length > MAX_CARTESIA_SNAPSHOT_VOICE_MODEL_PAIRS) {
    throw new RangeError(
      `Cartesia capability snapshot supports at most ${MAX_CARTESIA_SNAPSHOT_VOICE_MODEL_PAIRS} voice/model pairs`,
    );
  }

  validateIdentifiers(options.voiceIds, "voice");
  validateIdentifiers(options.modelIds, "model");
  return { modelIds: [...options.modelIds], voiceIds: [...options.voiceIds] };
}

function validateIdentifiers(values: readonly string[], name: "model" | "voice"): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (
      typeof value !== "string" ||
      value.trim().length === 0 ||
      value.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(value)
    ) {
      throw new TypeError(`Cartesia capability snapshot ${name} ID is invalid`);
    }
    if (seen.has(value))
      throw new TypeError(`Cartesia capability snapshot ${name} IDs must be unique`);
    seen.add(value);
  }
}

async function requestVoice(
  fetchImpl: typeof fetch,
  apiKey: string,
  voiceId: string,
  signal: AbortSignal | undefined,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(`https://api.cartesia.ai/voices/${encodeURIComponent(voiceId)}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Cartesia-Version": PROVIDER_API_VERSIONS.cartesia,
      },
      ...(signal ? { signal } : {}),
    });
  } catch {
    if (signal?.aborted) {
      throw providerConnectionCancelled(
        PROVIDER_NAMES.cartesia,
        "Cartesia voice capability request was cancelled",
      );
    }
    throw providerError(
      TVIC_ERROR_CODES.providerUpstreamFailed,
      "Cartesia voice capability request failed",
      { provider: PROVIDER_NAMES.cartesia, retriable: true },
    );
  }

  if (!response.ok) {
    throw cartesiaCapabilityRequestError(response.status);
  }
  return response;
}

function cartesiaCapabilityRequestError(status: number) {
  const message = `Cartesia voice capability request failed with HTTP ${status}`;
  const metadata = { httpStatus: status };
  if (status === 401 || status === 403) {
    return providerError(TVIC_ERROR_CODES.providerAuthFailed, message, {
      provider: PROVIDER_NAMES.cartesia,
      retriable: false,
      metadata,
    });
  }
  if (status >= 500) {
    return providerError(TVIC_ERROR_CODES.providerUpstreamFailed, message, {
      provider: PROVIDER_NAMES.cartesia,
      retriable: true,
      metadata,
    });
  }
  return providerError(TVIC_ERROR_CODES.providerInvalidRequest, message, {
    provider: PROVIDER_NAMES.cartesia,
    retriable: false,
    metadata,
  });
}

async function readVoicePayload(
  response: Response,
  signal: AbortSignal | undefined,
): Promise<Readonly<Record<string, unknown>>> {
  try {
    const text = await readBoundedResponseText(response, MAX_CARTESIA_SNAPSHOT_RESPONSE_BYTES);
    const body: unknown = JSON.parse(text);
    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      return body as Readonly<Record<string, unknown>>;
    }
  } catch {
    if (signal?.aborted) {
      throw providerConnectionCancelled(
        PROVIDER_NAMES.cartesia,
        "Cartesia voice capability response read was cancelled",
      );
    }
  }
  throw providerError(
    TVIC_ERROR_CODES.providerProtocolInvalid,
    "Cartesia returned an invalid voice capability response",
    { provider: PROVIDER_NAMES.cartesia, retriable: false },
  );
}

function readBooleanFact(feature: string, voice: string, value: unknown): ProviderCapabilityFact {
  return typeof value === "boolean"
    ? { feature, scope: "voice", voice, status: "supported", value }
    : { feature, scope: "voice", voice, status: "unknown" };
}

function readAccentLocalesFact(voice: string, value: unknown): ProviderCapabilityFact {
  if (!Array.isArray(value) || value.length === 0) {
    return {
      feature: PROVIDER_CAPABILITY_FEATURES.ttsVoiceAccentLocales,
      scope: "voice",
      voice,
      status: "unknown",
    };
  }
  const locales = new Set<string>();
  for (const accent of value) {
    if (
      typeof accent !== "object" ||
      accent === null ||
      Array.isArray(accent) ||
      typeof accent.locale !== "string" ||
      accent.locale.trim().length === 0 ||
      accent.locale.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(accent.locale)
    ) {
      return {
        feature: PROVIDER_CAPABILITY_FEATURES.ttsVoiceAccentLocales,
        scope: "voice",
        voice,
        status: "unknown",
      };
    }
    locales.add(accent.locale);
    if (locales.size > MAX_PROVIDER_CAPABILITY_VALUE_ITEMS) {
      return {
        feature: PROVIDER_CAPABILITY_FEATURES.ttsVoiceAccentLocales,
        scope: "voice",
        voice,
        status: "unknown",
      };
    }
  }
  if (locales.size === 0) {
    return {
      feature: PROVIDER_CAPABILITY_FEATURES.ttsVoiceAccentLocales,
      scope: "voice",
      voice,
      status: "unknown",
    };
  }
  return {
    feature: PROVIDER_CAPABILITY_FEATURES.ttsVoiceAccentLocales,
    scope: "voice",
    voice,
    status: "supported",
    value: [...locales],
  };
}
