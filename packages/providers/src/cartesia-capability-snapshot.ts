import {
  createProviderCapabilitySnapshot,
  PROVIDER_CAPABILITY_FEATURES,
  PROVIDER_NAMES,
  TVIC_ERROR_CODES,
} from "@tvic/core";
import type { ProviderCapabilityFact, ProviderCapabilitySnapshot } from "@tvic/core";

import { PROVIDER_API_VERSIONS } from "./catalog.js";
import { providerError } from "./common.js";

export const MAX_CARTESIA_SNAPSHOT_VOICE_IDS = 100;

export interface LoadCartesiaCapabilitySnapshotOptions {
  readonly apiKey: string;
  readonly voiceIds: readonly string[];
  readonly validUntil: string;
  readonly fetchedAt?: string;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
}

const CARTESIA_VOICE_SOURCE = "https://docs.cartesia.ai/api-reference/voices/get";

export async function loadCartesiaCapabilitySnapshot(
  options: LoadCartesiaCapabilitySnapshotOptions,
): Promise<ProviderCapabilitySnapshot> {
  const voiceIds = validateOptions(options);
  const snapshotMetadata = createProviderCapabilitySnapshot({
    provider: PROVIDER_NAMES.cartesia,
    source: CARTESIA_VOICE_SOURCE,
    fetchedAt: options.fetchedAt ?? new Date().toISOString(),
    validUntil: options.validUntil,
    facts: [],
  });
  const fetchImpl = options.fetchImpl ?? fetch;
  const facts: ProviderCapabilityFact[] = [];

  for (const voiceId of voiceIds) {
    const response = await requestVoice(fetchImpl, options.apiKey, voiceId, options.signal);
    const payload = await readVoicePayload(response);
    if (payload.id !== voiceId) {
      throw providerError(
        TVIC_ERROR_CODES.providerProtocolInvalid,
        "Cartesia voice response did not match the requested voice",
        { provider: PROVIDER_NAMES.cartesia, retriable: false },
      );
    }

    facts.push({
      feature: PROVIDER_CAPABILITY_FEATURES.ttsVoiceAvailable,
      scope: "voice",
      voice: voiceId,
      status:
        payload.status === "active"
          ? "supported"
          : payload.status === "archived"
            ? "unsupported"
            : "unknown",
    });
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

function validateOptions(options: LoadCartesiaCapabilitySnapshotOptions): readonly string[] {
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

  const seen = new Set<string>();
  for (const voiceId of options.voiceIds) {
    if (
      typeof voiceId !== "string" ||
      voiceId.trim().length === 0 ||
      voiceId.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(voiceId)
    ) {
      throw new TypeError("Cartesia capability snapshot voice ID is invalid");
    }
    if (seen.has(voiceId)) {
      throw new TypeError("Cartesia capability snapshot voice IDs must be unique");
    }
    seen.add(voiceId);
  }
  return options.voiceIds;
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
    throw providerError(
      TVIC_ERROR_CODES.providerUpstreamFailed,
      "Cartesia voice capability request failed",
      { provider: PROVIDER_NAMES.cartesia, retriable: true },
    );
  }

  if (!response.ok) {
    throw providerError(
      response.status === 401 || response.status === 403
        ? TVIC_ERROR_CODES.providerAuthFailed
        : response.status >= 500
          ? TVIC_ERROR_CODES.providerUpstreamFailed
          : TVIC_ERROR_CODES.providerInvalidRequest,
      `Cartesia voice capability request failed with HTTP ${response.status}`,
      {
        provider: PROVIDER_NAMES.cartesia,
        retriable: response.status >= 500,
        metadata: { httpStatus: response.status },
      },
    );
  }
  return response;
}

async function readVoicePayload(response: Response): Promise<Readonly<Record<string, unknown>>> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      return body as Readonly<Record<string, unknown>>;
    }
  } catch {}
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
  const locales = value.map((accent) => {
    if (
      typeof accent !== "object" ||
      accent === null ||
      Array.isArray(accent) ||
      typeof accent.locale !== "string"
    ) {
      return undefined;
    }
    return accent.locale;
  });
  if (locales.some((locale) => locale === undefined)) {
    return {
      feature: PROVIDER_CAPABILITY_FEATURES.ttsVoiceAccentLocales,
      scope: "voice",
      voice,
      status: "unknown",
    };
  }
  const validLocales = locales.filter((locale): locale is string => typeof locale === "string");
  return {
    feature: PROVIDER_CAPABILITY_FEATURES.ttsVoiceAccentLocales,
    scope: "voice",
    voice,
    status: "supported",
    value: [...new Set(validLocales)],
  };
}
