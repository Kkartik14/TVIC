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

export interface LoadCartesiaVoiceControlSnapshotOptions {
  readonly apiKey: string;
  readonly voiceId: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

export async function loadCartesiaVoiceControlSnapshot(
  options: LoadCartesiaVoiceControlSnapshotOptions,
): Promise<SpeechControlCatalogSnapshot> {
  const apiKey = nonEmpty(options.apiKey, "Cartesia API key");
  const voiceId = nonEmpty(options.voiceId, "Cartesia voice ID");
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

  const metadata = parseVoiceMetadata(await readBoundedResponse(response));
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

async function readBoundedResponse(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Cartesia voice metadata response body is missing");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_CARTESIA_VOICE_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Cartesia voice metadata response exceeded the size limit");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
