export const MAX_PROVIDER_CAPABILITY_FACTS = 512;
export const MAX_PROVIDER_CAPABILITY_SNAPSHOTS = 32;
export const MAX_PROVIDER_CAPABILITY_PROVIDER_LENGTH = 128;
export const MAX_PROVIDER_CAPABILITY_FEATURE_LENGTH = 128;
export const MAX_PROVIDER_CAPABILITY_SOURCE_LENGTH = 2_048;
export const MAX_PROVIDER_CAPABILITY_IDENTIFIER_LENGTH = 256;
export const MAX_PROVIDER_CAPABILITY_VALUE_ITEMS = 64;
export const PROVIDER_CAPABILITY_FEATURES = Object.freeze({
  ttsVoiceAvailable: "tts.voice.available",
  ttsVoiceIsPro: "tts.voice.isPro",
  ttsVoiceAccentLocales: "tts.voice.accentLocales",
} as const);

export type ProviderCapabilityValue = string | number | boolean | readonly string[];

export type ProviderCapabilityStatus = "supported" | "unsupported" | "unknown";
export type ProviderCapabilityScope = "provider" | "account" | "model" | "voice";

export interface ProviderCapabilityFact {
  readonly feature: string;
  readonly scope: ProviderCapabilityScope;
  readonly status: ProviderCapabilityStatus;
  readonly model?: string;
  readonly voice?: string;
  readonly value?: ProviderCapabilityValue;
}

export interface ProviderCapabilitySnapshot {
  readonly provider: string;
  readonly source: string;
  readonly fetchedAt: string;
  readonly validUntil: string;
  readonly facts: readonly ProviderCapabilityFact[];
}

export interface ProviderCapabilityQuery {
  readonly provider: string;
  readonly feature: string;
  readonly scope: ProviderCapabilityScope;
  readonly model?: string;
  readonly voice?: string;
}

export type ProviderCapabilityResolution =
  | {
      readonly status: "supported" | "unsupported";
      readonly provider: string;
      readonly feature: string;
      readonly scope: ProviderCapabilityScope;
      readonly source: string;
      readonly validUntil: string;
      readonly value?: ProviderCapabilityValue;
    }
  | {
      readonly status: "unknown";
      readonly provider: string;
      readonly feature: string;
      readonly reason:
        | "snapshot_missing"
        | "snapshot_ambiguous"
        | "snapshot_not_yet_valid"
        | "snapshot_expired"
        | "fact_missing"
        | "fact_unknown";
      readonly scope?: ProviderCapabilityScope;
      readonly source?: string;
    };

export function createProviderCapabilitySnapshot(
  input: ProviderCapabilitySnapshot,
): ProviderCapabilitySnapshot {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("Provider capability snapshot must be an object");
  }
  assertIdentifier(input.provider, "provider", MAX_PROVIDER_CAPABILITY_PROVIDER_LENGTH);
  assertIdentifier(input.source, "source", MAX_PROVIDER_CAPABILITY_SOURCE_LENGTH);
  assertTimestamp(input.fetchedAt, "fetchedAt");
  assertTimestamp(input.validUntil, "validUntil");
  if (Date.parse(input.validUntil) <= Date.parse(input.fetchedAt)) {
    throw new TypeError("Provider capability snapshot validUntil must be after fetchedAt");
  }
  if (!Array.isArray(input.facts) || input.facts.length > MAX_PROVIDER_CAPABILITY_FACTS) {
    throw new TypeError(
      `Provider capability snapshot facts must contain at most ${MAX_PROVIDER_CAPABILITY_FACTS} entries`,
    );
  }

  const seen = new Set<string>();
  const facts = input.facts.map((fact) => {
    assertIdentifier(fact.feature, "feature", MAX_PROVIDER_CAPABILITY_FEATURE_LENGTH);
    if (
      fact.scope !== "provider" &&
      fact.scope !== "account" &&
      fact.scope !== "model" &&
      fact.scope !== "voice"
    ) {
      throw new TypeError("Provider capability fact scope is invalid");
    }
    if (fact.status !== "supported" && fact.status !== "unsupported" && fact.status !== "unknown") {
      throw new TypeError("Provider capability fact status is invalid");
    }
    if (fact.model !== undefined) {
      assertIdentifier(fact.model, "model", MAX_PROVIDER_CAPABILITY_IDENTIFIER_LENGTH);
    }
    if (fact.voice !== undefined) {
      assertIdentifier(fact.voice, "voice", MAX_PROVIDER_CAPABILITY_IDENTIFIER_LENGTH);
    }
    const value = normalizeCapabilityValue(fact.value);
    if (
      (fact.scope === "provider" && (fact.model !== undefined || fact.voice !== undefined)) ||
      (fact.scope === "account" && fact.voice !== undefined) ||
      (fact.scope === "model" && (fact.model === undefined || fact.voice !== undefined)) ||
      (fact.scope === "voice" && fact.voice === undefined)
    ) {
      throw new TypeError("Provider capability fact selectors do not match its scope");
    }
    const key = JSON.stringify([fact.feature, fact.scope, fact.model ?? null, fact.voice ?? null]);
    if (seen.has(key))
      throw new TypeError("Provider capability snapshot has duplicate capability fact");
    seen.add(key);
    return Object.freeze({
      feature: fact.feature,
      scope: fact.scope,
      status: fact.status,
      ...(fact.model !== undefined ? { model: fact.model } : {}),
      ...(fact.voice !== undefined ? { voice: fact.voice } : {}),
      ...(value !== undefined ? { value } : {}),
    });
  });

  return Object.freeze({
    provider: input.provider,
    source: assertHttpsUrl(input.source),
    fetchedAt: input.fetchedAt,
    validUntil: input.validUntil,
    facts: Object.freeze(facts),
  });
}

export function resolveProviderCapability(
  snapshots: readonly ProviderCapabilitySnapshot[],
  query: ProviderCapabilityQuery,
  nowMs = Date.now(),
): ProviderCapabilityResolution {
  assertIdentifier(query.provider, "provider", MAX_PROVIDER_CAPABILITY_PROVIDER_LENGTH);
  assertIdentifier(query.feature, "feature", MAX_PROVIDER_CAPABILITY_FEATURE_LENGTH);
  if (
    query.scope !== "provider" &&
    query.scope !== "account" &&
    query.scope !== "model" &&
    query.scope !== "voice"
  ) {
    throw new TypeError("Provider capability query scope is invalid");
  }
  if (query.model !== undefined) {
    assertIdentifier(query.model, "model", MAX_PROVIDER_CAPABILITY_IDENTIFIER_LENGTH);
  }
  if (query.voice !== undefined) {
    assertIdentifier(query.voice, "voice", MAX_PROVIDER_CAPABILITY_IDENTIFIER_LENGTH);
  }
  if (
    (query.scope === "provider" && (query.model !== undefined || query.voice !== undefined)) ||
    (query.scope === "account" && query.voice !== undefined) ||
    (query.scope === "model" && (query.model === undefined || query.voice !== undefined)) ||
    (query.scope === "voice" && query.voice === undefined)
  ) {
    throw new TypeError("Provider capability query selectors do not match its scope");
  }
  if (!Number.isFinite(nowMs)) throw new TypeError("nowMs must be finite");
  if (!Array.isArray(snapshots) || snapshots.length > MAX_PROVIDER_CAPABILITY_SNAPSHOTS) {
    throw new TypeError(
      `Provider capability snapshots must contain at most ${MAX_PROVIDER_CAPABILITY_SNAPSHOTS} entries`,
    );
  }

  const providerSnapshots = snapshots.map(createProviderCapabilitySnapshot);
  const matches = providerSnapshots.filter((snapshot) => snapshot.provider === query.provider);
  if (matches.length === 0) {
    return {
      status: "unknown",
      provider: query.provider,
      feature: query.feature,
      reason: "snapshot_missing",
    };
  }
  if (matches.length > 1) {
    return {
      status: "unknown",
      provider: query.provider,
      feature: query.feature,
      reason: "snapshot_ambiguous",
    };
  }
  const snapshot = matches[0]!;
  if (nowMs < Date.parse(snapshot.fetchedAt)) {
    return {
      status: "unknown",
      provider: query.provider,
      feature: query.feature,
      reason: "snapshot_not_yet_valid",
      source: snapshot.source,
    };
  }
  if (nowMs >= Date.parse(snapshot.validUntil)) {
    return {
      status: "unknown",
      provider: query.provider,
      feature: query.feature,
      reason: "snapshot_expired",
      source: snapshot.source,
    };
  }

  const selected = snapshot.facts.find(
    (fact) =>
      fact.feature === query.feature &&
      fact.scope === query.scope &&
      fact.model === query.model &&
      fact.voice === query.voice,
  );
  if (!selected) {
    return {
      status: "unknown",
      provider: query.provider,
      feature: query.feature,
      reason: "fact_missing",
      source: snapshot.source,
    };
  }
  if (selected.status === "unknown") {
    return {
      status: "unknown",
      provider: query.provider,
      feature: query.feature,
      reason: "fact_unknown",
      scope: selected.scope,
      source: snapshot.source,
    };
  }
  return {
    status: selected.status,
    provider: query.provider,
    feature: query.feature,
    scope: selected.scope,
    source: snapshot.source,
    validUntil: snapshot.validUntil,
    ...(selected.value !== undefined ? { value: selected.value } : {}),
  };
}

function normalizeCapabilityValue(value: unknown): ProviderCapabilityValue | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    assertIdentifier(value, "value", MAX_PROVIDER_CAPABILITY_IDENTIFIER_LENGTH);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Provider capability value is invalid");
    return value;
  }
  if (typeof value === "boolean") return value;
  if (
    !Array.isArray(value) ||
    value.length > MAX_PROVIDER_CAPABILITY_VALUE_ITEMS ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new TypeError("Provider capability value is invalid");
  }
  return Object.freeze(
    value.map((item) => {
      assertIdentifier(item, "value item", MAX_PROVIDER_CAPABILITY_IDENTIFIER_LENGTH);
      return item;
    }),
  );
}

function assertIdentifier(
  value: unknown,
  name: string,
  maxLength: number,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maxLength ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`Provider capability ${name} is invalid`);
  }
}

function assertTimestamp(value: unknown, name: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new TypeError(`Provider capability snapshot ${name} must be a UTC timestamp`);
  }
}

function assertHttpsUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Provider capability snapshot source must be an HTTPS URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new TypeError("Provider capability snapshot source must be an HTTPS URL");
  }
  return value;
}
