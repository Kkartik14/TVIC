import { PROVIDER_NAMES, TVIC_ERROR_CODES, TvicThrowableError, providerError } from "@tvic/core";

import { PROVIDER_API_VERSIONS } from "./catalog.js";

export interface CartesiaVoiceCatalogEntry {
  readonly id: string;
  readonly status: "active" | "archived";
  readonly isPro: boolean;
  readonly locales?: readonly string[];
}

export interface CartesiaVoiceCatalogSnapshot {
  readonly fetchedAtMs: number;
  readonly expiresAtMs: number;
  readonly voices: readonly CartesiaVoiceCatalogEntry[];
}

export interface FetchCartesiaVoiceCatalogSnapshotOptions {
  readonly apiKey: string;
  readonly voiceIds: readonly string[];
  readonly nowMs?: number;
  readonly ttlMs?: number;
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_SNAPSHOT_TTL_MS = 86_400_000;
const MAX_SNAPSHOT_VOICES = 100;

export async function fetchCartesiaVoiceCatalogSnapshot(
  options: FetchCartesiaVoiceCatalogSnapshotOptions,
): Promise<CartesiaVoiceCatalogSnapshot> {
  const fetchedAtMs = options.nowMs ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_SNAPSHOT_TTL_MS;
  if (
    typeof options.apiKey !== "string" ||
    options.apiKey.trim().length === 0 ||
    !Number.isSafeInteger(fetchedAtMs) ||
    fetchedAtMs < 0 ||
    !Number.isSafeInteger(ttlMs) ||
    ttlMs <= 0 ||
    !Array.isArray(options.voiceIds) ||
    options.voiceIds.length > MAX_SNAPSHOT_VOICES ||
    !options.voiceIds.every(isVoiceId)
  ) {
    throw new TypeError("Cartesia voice snapshot request is invalid");
  }

  const voiceIds = [...new Set(options.voiceIds)];
  const fetchImpl = options.fetchImpl ?? fetch;
  const voices = await Promise.all(
    voiceIds.map(async (voiceId) => {
      let response: Response;
      try {
        response = await fetchImpl(
          `https://api.cartesia.ai/voices/${encodeURIComponent(voiceId)}`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${options.apiKey}`,
              "Cartesia-Version": PROVIDER_API_VERSIONS.cartesia,
            },
          },
        );
      } catch {
        return catalogFailure("Cartesia voice metadata could not be retrieved", true);
      }
      if (!response.ok) {
        return catalogFailure(
          "Cartesia voice metadata could not be retrieved",
          response.status >= 500,
          {
            status: response.status,
          },
        );
      }

      let value: unknown;
      try {
        value = await response.json();
      } catch {
        return catalogFailure("Cartesia returned invalid voice metadata", false);
      }
      return parseVoiceEntry(value, voiceId);
    }),
  );

  return Object.freeze({
    fetchedAtMs,
    expiresAtMs: fetchedAtMs + ttlMs,
    voices: Object.freeze(voices),
  });
}

export function normalizeCartesiaVoiceCatalogSnapshot(
  value: unknown,
): CartesiaVoiceCatalogSnapshot {
  if (!isRecord(value)) throw new TypeError("Cartesia voice catalog snapshot is invalid");
  const { fetchedAtMs, expiresAtMs, voices } = value;
  if (
    typeof fetchedAtMs !== "number" ||
    !Number.isSafeInteger(fetchedAtMs) ||
    fetchedAtMs < 0 ||
    typeof expiresAtMs !== "number" ||
    !Number.isSafeInteger(expiresAtMs) ||
    expiresAtMs <= fetchedAtMs ||
    !Array.isArray(voices) ||
    voices.length > MAX_SNAPSHOT_VOICES
  ) {
    throw new TypeError("Cartesia voice catalog snapshot is invalid");
  }
  const entries = voices.map(normalizeVoiceEntry);
  if (new Set(entries.map((voice) => voice.id)).size !== entries.length) {
    throw new TypeError("Cartesia voice catalog snapshot contains duplicate ids");
  }
  return Object.freeze({
    fetchedAtMs,
    expiresAtMs,
    voices: Object.freeze(entries),
  });
}

export function cartesiaVoiceCatalogEntry(
  snapshot: CartesiaVoiceCatalogSnapshot | undefined,
  voiceId: string,
  nowMs = Date.now(),
): CartesiaVoiceCatalogEntry | undefined {
  if (
    !snapshot ||
    !Number.isSafeInteger(nowMs) ||
    snapshot.fetchedAtMs > nowMs ||
    snapshot.expiresAtMs <= nowMs
  ) {
    return undefined;
  }
  return snapshot.voices.find((voice) => voice.id === voiceId);
}

function parseVoiceEntry(value: unknown, expectedId?: string): CartesiaVoiceCatalogEntry {
  if (!isRecord(value)) return catalogFailure("Cartesia returned invalid voice metadata", false);
  const { id, status, is_pro: isPro, accents } = value;
  if (
    !isVoiceId(id) ||
    (expectedId !== undefined && id !== expectedId) ||
    (status !== "active" && status !== "archived") ||
    typeof isPro !== "boolean" ||
    (accents !== undefined &&
      (!Array.isArray(accents) ||
        !accents.every((accent) => isRecord(accent) && isLanguageTag(accent.locale))))
  ) {
    return catalogFailure("Cartesia returned invalid voice metadata", false);
  }
  const locales =
    accents === undefined
      ? undefined
      : Object.freeze([...new Set(accents.map((accent) => (accent as { locale: string }).locale))]);
  return Object.freeze({
    id,
    status,
    isPro,
    ...(locales !== undefined ? { locales } : {}),
  });
}

function normalizeVoiceEntry(value: unknown): CartesiaVoiceCatalogEntry {
  if (!isRecord(value)) throw new TypeError("Cartesia voice catalog entry is invalid");
  const { id, status, isPro, locales } = value;
  if (
    !isVoiceId(id) ||
    (status !== "active" && status !== "archived") ||
    typeof isPro !== "boolean" ||
    (locales !== undefined && (!Array.isArray(locales) || !locales.every(isLanguageTag)))
  ) {
    throw new TypeError("Cartesia voice catalog entry is invalid");
  }
  return Object.freeze({
    id,
    status,
    isPro,
    ...(locales !== undefined ? { locales: Object.freeze([...new Set(locales)]) } : {}),
  });
}

function isVoiceId(value: unknown): value is string {
  return (
    typeof value === "string" && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function isLanguageTag(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function catalogFailure(
  message: string,
  retriable: boolean,
  metadata?: Readonly<Record<string, unknown>>,
): never {
  throw TvicThrowableError.from(
    providerError(TVIC_ERROR_CODES.providerProtocolInvalid, message, {
      provider: PROVIDER_NAMES.cartesia,
      retriable,
      ...(metadata !== undefined ? { metadata } : {}),
    }),
  );
}
