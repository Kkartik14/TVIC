export type SpeechControlStatus = "supported" | "unsupported";
export type SpeechControlMutability = "provider" | "call" | "turn";

export type SpeechControlScope =
  | { readonly type: "provider" }
  | { readonly type: "model"; readonly model: string }
  | { readonly type: "voice"; readonly model: string; readonly voice: string }
  | { readonly type: "account"; readonly model?: string; readonly voice?: string };

export interface SpeechControlFact {
  readonly provider: string;
  readonly control: string;
  readonly scope: SpeechControlScope;
  readonly status: SpeechControlStatus;
  readonly mutability: SpeechControlMutability;
  readonly source: string;
  readonly verifiedAt: string;
  readonly limits?: Readonly<Record<string, number | string | boolean>>;
  readonly languages?: readonly string[];
}

export interface SpeechControlCatalogSnapshot {
  readonly version: 1;
  readonly fetchedAt: string;
  readonly validUntil: string;
  readonly facts: readonly SpeechControlFact[];
}

export interface SpeechControlCatalogSnapshotOptions {
  readonly fetchedAt: string;
  readonly validUntil: string;
}

export interface SpeechControlQuery {
  readonly provider: string;
  readonly control: string;
  readonly model?: string;
  readonly voice?: string;
}

export type SpeechControlLookup =
  | { readonly status: "supported" | "unsupported"; readonly fact: SpeechControlFact }
  | { readonly status: "unknown" | "expired" | "not_yet_valid" };

const MAX_SPEECH_CONTROL_FACTS = 4_096;
const MAX_SPEECH_CONTROL_IDENTIFIER_LENGTH = 128;
const MAX_SPEECH_CONTROL_SOURCE_LENGTH = 2_048;

export function createSpeechControlCatalogSnapshot(
  facts: readonly SpeechControlFact[],
  options: SpeechControlCatalogSnapshotOptions,
): SpeechControlCatalogSnapshot {
  if (!Array.isArray(facts) || facts.length > MAX_SPEECH_CONTROL_FACTS) {
    throw new TypeError(
      `Speech control catalog must contain at most ${MAX_SPEECH_CONTROL_FACTS} facts`,
    );
  }
  const fetchedAt = parseTimestamp(options?.fetchedAt, "fetchedAt");
  const validUntil = parseTimestamp(options?.validUntil, "validUntil");
  if (validUntil <= fetchedAt) {
    throw new TypeError("Speech control catalog validUntil must be later than fetchedAt");
  }

  const keys = new Set<string>();
  const snapshotFacts = facts.map((fact) => {
    const copied = copyFact(fact);
    const key = factKey(copied);
    if (keys.has(key)) throw new TypeError("Speech control catalog contains a duplicate fact");
    keys.add(key);
    return copied;
  });

  return Object.freeze({
    version: 1,
    fetchedAt: new Date(fetchedAt).toISOString(),
    validUntil: new Date(validUntil).toISOString(),
    facts: Object.freeze(snapshotFacts),
  });
}

export function querySpeechControlCatalog(
  snapshot: SpeechControlCatalogSnapshot,
  query: SpeechControlQuery,
  now = new Date().toISOString(),
): SpeechControlLookup {
  const currentTime = parseTimestamp(now, "now");
  const fetchedAt = parseTimestamp(snapshot.fetchedAt, "fetchedAt");
  const expiresAt = parseTimestamp(snapshot.validUntil, "validUntil");
  if (currentTime < fetchedAt) return { status: "not_yet_valid" };
  if (currentTime >= expiresAt) return { status: "expired" };
  validateQuery(query);

  const candidates = snapshot.facts.filter(
    (fact) =>
      fact.provider === query.provider &&
      fact.control === query.control &&
      scopeMatches(fact.scope, query),
  );
  candidates.sort((left, right) => scopeRank(right.scope) - scopeRank(left.scope));
  const fact = candidates[0];
  const nextFact = candidates[1];
  if (
    fact !== undefined &&
    nextFact !== undefined &&
    scopeRank(fact.scope) === scopeRank(nextFact.scope)
  ) {
    return { status: "unknown" };
  }
  return fact ? { status: fact.status, fact } : { status: "unknown" };
}

export function hasSpeechControlCatalogFact(
  snapshot: SpeechControlCatalogSnapshot,
  provider: string,
  control: string,
): boolean {
  assertIdentifier(provider, "provider");
  assertIdentifier(control, "control");
  if (!Array.isArray(snapshot?.facts)) {
    throw new TypeError("Speech control catalog facts must be an array");
  }
  return snapshot.facts.some((fact) => fact.provider === provider && fact.control === control);
}

function copyFact(value: SpeechControlFact): SpeechControlFact {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Speech control fact must be an object");
  }
  const { provider, control, scope, status, mutability, source, verifiedAt, limits, languages } =
    value;
  assertIdentifier(provider, "provider");
  assertIdentifier(control, "control");
  assertIdentifier(status, "status");
  if (status !== "supported" && status !== "unsupported") {
    throw new TypeError("Speech control fact status is invalid");
  }
  if (mutability !== "provider" && mutability !== "call" && mutability !== "turn") {
    throw new TypeError("Speech control fact mutability is invalid");
  }
  if (
    typeof source !== "string" ||
    source.length === 0 ||
    source.length > MAX_SPEECH_CONTROL_SOURCE_LENGTH
  ) {
    throw new TypeError("Speech control fact source is invalid");
  }
  if (!isHttpsUrl(source)) throw new TypeError("Speech control fact source must be an HTTPS URL");
  if (!isDateOnly(verifiedAt))
    throw new TypeError("Speech control fact verifiedAt must be YYYY-MM-DD");
  const frozenScope = copyScope(scope);
  const frozenLimits = copyLimits(limits);
  const frozenLanguages = copyLanguages(languages);
  return Object.freeze({
    provider,
    control,
    scope: frozenScope,
    status,
    mutability,
    source,
    verifiedAt,
    ...(frozenLimits ? { limits: frozenLimits } : {}),
    ...(frozenLanguages ? { languages: frozenLanguages } : {}),
  });
}

function copyScope(value: SpeechControlScope): SpeechControlScope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Speech control fact scope must be an object");
  }
  switch (value.type) {
    case "provider":
      if (Object.keys(value).some((key) => key !== "type")) {
        throw new TypeError("Provider scope must not include model or voice fields");
      }
      return Object.freeze({ type: "provider" });
    case "model":
      assertNoExtraKeys(value, ["type", "model"], "Model scope");
      assertIdentifier(value.model, "scope.model");
      return Object.freeze({ type: "model", model: value.model });
    case "voice":
      assertNoExtraKeys(value, ["type", "model", "voice"], "Voice scope");
      assertIdentifier(value.model, "scope.model");
      assertIdentifier(value.voice, "scope.voice");
      return Object.freeze({ type: "voice", model: value.model, voice: value.voice });
    case "account": {
      assertNoExtraKeys(value, ["type", "model", "voice"], "Account scope");
      const model = value.model;
      const voice = value.voice;
      if (model !== undefined) assertIdentifier(model, "scope.model");
      if (voice !== undefined) assertIdentifier(voice, "scope.voice");
      return Object.freeze({
        type: "account",
        ...(model !== undefined ? { model } : {}),
        ...(voice !== undefined ? { voice } : {}),
      });
    }
    default:
      throw new TypeError("Speech control fact scope type is invalid");
  }
}

function copyLimits(
  value: Readonly<Record<string, number | string | boolean>> | undefined,
): Readonly<Record<string, number | string | boolean>> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Speech control fact limits must be an object");
  }
  const entries = Object.entries(value);
  if (entries.length > 32) throw new TypeError("Speech control fact has too many limits");
  const copied: Record<string, number | string | boolean> = {};
  for (const [key, item] of entries) {
    assertIdentifier(key, "limit name");
    if (
      (typeof item === "number" && !Number.isFinite(item)) ||
      (typeof item !== "number" && typeof item !== "string" && typeof item !== "boolean") ||
      (typeof item === "string" && item.length > 256)
    ) {
      throw new TypeError(`Speech control fact limit ${key} is invalid`);
    }
    copied[key] = item;
  }
  return Object.freeze(copied);
}

function copyLanguages(value: readonly string[] | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 128) {
    throw new TypeError("Speech control fact languages must contain at most 128 tags");
  }
  const unique = new Set<string>();
  for (const language of value) {
    if (typeof language !== "string" || language.trim() !== language || language.length > 64) {
      throw new TypeError("Speech control fact language is invalid");
    }
    let canonical: string | undefined;
    try {
      canonical = Intl.getCanonicalLocales(language)[0];
    } catch {
      canonical = undefined;
    }
    if (canonical !== language || unique.has(language)) {
      throw new TypeError("Speech control fact languages must be unique BCP-47 tags");
    }
    unique.add(language);
  }
  return Object.freeze([...unique]);
}

function scopeMatches(scope: SpeechControlScope, query: SpeechControlQuery): boolean {
  switch (scope.type) {
    case "provider":
      return true;
    case "model":
      return query.model === scope.model;
    case "voice":
      return query.model === scope.model && query.voice === scope.voice;
    case "account":
      return (
        (scope.model === undefined || query.model === scope.model) &&
        (scope.voice === undefined || query.voice === scope.voice)
      );
  }
}

function scopeRank(scope: SpeechControlScope): number {
  switch (scope.type) {
    case "provider":
      return 1;
    case "model":
      return 2;
    case "voice":
      return 3;
    case "account":
      return 4 + Number(scope.model !== undefined) + Number(scope.voice !== undefined);
  }
}

function factKey(fact: SpeechControlFact): string {
  return JSON.stringify([fact.provider, fact.control, fact.scope]);
}

function validateQuery(query: SpeechControlQuery): void {
  if (typeof query !== "object" || query === null || Array.isArray(query)) {
    throw new TypeError("Speech control query must be an object");
  }
  assertIdentifier(query.provider, "query.provider");
  assertIdentifier(query.control, "query.control");
  if (query.model !== undefined) assertIdentifier(query.model, "query.model");
  if (query.voice !== undefined) assertIdentifier(query.voice, "query.voice");
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0 ||
    value.length > MAX_SPEECH_CONTROL_IDENTIFIER_LENGTH
  ) {
    throw new TypeError(`Speech control ${label} is invalid`);
  }
}

function parseTimestamp(value: unknown, label: string): number {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) ||
    !isValidCalendarDate(value.slice(0, 10)) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new TypeError(`Speech control ${label} must be an ISO timestamp`);
  }
  return Date.parse(value);
}

function isDateOnly(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  return isValidCalendarDate(value);
}

function isValidCalendarDate(value: string): boolean {
  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (!Number.isInteger(year) || year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) {
    return false;
  }
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1]!;
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username.length === 0 && url.password.length === 0;
  } catch {
    return false;
  }
}

function assertNoExtraKeys(value: object, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new TypeError(`${label} contains unsupported fields`);
  }
}
