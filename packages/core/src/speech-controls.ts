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
const MAX_SPEECH_CONTROL_SNAPSHOT_BYTES = 1_048_576;
const MAX_SPEECH_CONTROL_ACCOUNT_SNAPSHOTS = 16;
const MAX_SPEECH_CONTROL_IDENTIFIER_LENGTH = 128;
const MAX_SPEECH_CONTROL_SOURCE_LENGTH = 2_048;
const IMMUTABLE_SPEECH_CONTROL_SNAPSHOTS = new WeakSet<SpeechControlCatalogSnapshot>();

export function createSpeechControlCatalogSnapshot(
  facts: readonly SpeechControlFact[],
  options: SpeechControlCatalogSnapshotOptions,
): SpeechControlCatalogSnapshot {
  return buildSpeechControlCatalogSnapshot(facts, [], options);
}

export function cloneSpeechControlCatalogSnapshot(
  snapshot: SpeechControlCatalogSnapshot,
): SpeechControlCatalogSnapshot {
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
    throw new TypeError("Speech control catalog snapshot must be an object");
  }
  if (IMMUTABLE_SPEECH_CONTROL_SNAPSHOTS.has(snapshot)) return snapshot;
  if (snapshot.version !== 1) {
    throw new TypeError("Speech control catalog snapshot version is unsupported");
  }
  return buildSpeechControlCatalogSnapshot(snapshot.facts, [], {
    fetchedAt: snapshot.fetchedAt,
    validUntil: snapshot.validUntil,
  });
}

export function composeSpeechControlCatalogSnapshot(
  staticFacts: readonly SpeechControlFact[],
  accountSnapshots: readonly SpeechControlCatalogSnapshot[],
  options: SpeechControlCatalogSnapshotOptions,
): SpeechControlCatalogSnapshot {
  if (!Array.isArray(accountSnapshots)) {
    throw new TypeError("Account speech-control snapshots must be an array");
  }
  if (accountSnapshots.length > MAX_SPEECH_CONTROL_ACCOUNT_SNAPSHOTS) {
    throw new TypeError(
      `Speech control catalog accepts at most ${MAX_SPEECH_CONTROL_ACCOUNT_SNAPSHOTS} account snapshots`,
    );
  }
  return buildSpeechControlCatalogSnapshot(staticFacts, accountSnapshots, options);
}

function buildSpeechControlCatalogSnapshot(
  staticFacts: readonly SpeechControlFact[],
  accountSnapshots: readonly SpeechControlCatalogSnapshot[],
  options: SpeechControlCatalogSnapshotOptions,
): SpeechControlCatalogSnapshot {
  if (!Array.isArray(staticFacts) || staticFacts.length > MAX_SPEECH_CONTROL_FACTS) {
    throw tooManySpeechControlFactsError();
  }
  const fetchedAt = parseTimestamp(options?.fetchedAt, "fetchedAt");
  let validUntil = parseTimestamp(options?.validUntil, "validUntil");
  if (validUntil <= fetchedAt) {
    throw new TypeError("Speech control catalog validUntil must be later than fetchedAt");
  }
  const snapshotEnvelopeBytes = snapshotEnvelopeSizeBytes(fetchedAt, validUntil);

  const facts = new Map<string, SpeechControlFact>();
  const factSizes = new Map<string, number>();
  let snapshotBytes = 0;
  for (const value of staticFacts) {
    const fact = copyFact(value);
    const key = factKey(fact);
    if (facts.has(key)) throw new TypeError("Speech control catalog contains a duplicate fact");
    const size = factSizeBytes(fact);
    assertFactBudget(facts.size + 1, snapshotBytes + size, snapshotEnvelopeBytes);
    facts.set(key, fact);
    factSizes.set(key, size);
    snapshotBytes += size;
  }

  const accountFactKeys = new Set<string>();
  for (const snapshot of accountSnapshots) {
    if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
      throw new TypeError("Account speech-control snapshot must be an object");
    }
    if (!Array.isArray(snapshot.facts) || snapshot.facts.length > MAX_SPEECH_CONTROL_FACTS) {
      throw tooManySpeechControlFactsError();
    }
    const accountFetchedAt = parseTimestamp(snapshot.fetchedAt, "account fetchedAt");
    const accountValidUntil = parseTimestamp(snapshot.validUntil, "account validUntil");
    if (accountValidUntil <= accountFetchedAt) {
      throw new TypeError(
        "Account speech-control snapshot validUntil must be later than fetchedAt",
      );
    }
    if (accountFetchedAt > fetchedAt) {
      throw new TypeError(
        "Account speech-control snapshot was fetched after the combined snapshot",
      );
    }
    if (accountValidUntil <= fetchedAt) {
      throw new TypeError("Account speech-control snapshot is expired at the combined fetchedAt");
    }
    validUntil = Math.min(validUntil, accountValidUntil);

    let accountFactCount = 0;
    let accountSnapshotBytes = 0;
    for (const value of snapshot.facts) {
      const fact = copyFact(value);
      const key = factKey(fact);
      if (accountFactKeys.has(key)) {
        throw new TypeError("Account speech-control snapshots contain duplicate facts");
      }
      accountFactKeys.add(key);
      accountFactCount += 1;
      const size = factSizeBytes(fact);
      accountSnapshotBytes += size;
      assertFactBudget(
        accountFactCount,
        accountSnapshotBytes,
        snapshotEnvelopeSizeBytes(accountFetchedAt, accountValidUntil),
      );

      const previousSize = factSizes.get(key) ?? 0;
      const nextFactCount = facts.size + Number(!facts.has(key));
      const nextSnapshotBytes = snapshotBytes - previousSize + size;
      assertFactBudget(nextFactCount, nextSnapshotBytes, snapshotEnvelopeBytes);
      facts.set(key, fact);
      factSizes.set(key, size);
      snapshotBytes = nextSnapshotBytes;
    }
  }

  const snapshot = Object.freeze({
    version: 1,
    fetchedAt: new Date(fetchedAt).toISOString(),
    validUntil: new Date(validUntil).toISOString(),
    facts: Object.freeze([...facts.values()]),
  });
  IMMUTABLE_SPEECH_CONTROL_SNAPSHOTS.add(snapshot);
  return snapshot;
}

function assertFactBudget(
  factCount: number,
  factBytes: number,
  snapshotEnvelopeBytes: number,
): void {
  if (factCount > MAX_SPEECH_CONTROL_FACTS) throw tooManySpeechControlFactsError();
  const serializedBytes = snapshotEnvelopeBytes + factBytes + Math.max(0, factCount - 1);
  if (serializedBytes > MAX_SPEECH_CONTROL_SNAPSHOT_BYTES) {
    throw new TypeError(
      `Speech control catalog exceeds the aggregate size limit of ${MAX_SPEECH_CONTROL_SNAPSHOT_BYTES} bytes`,
    );
  }
}

function tooManySpeechControlFactsError(): TypeError {
  return new TypeError(
    `Speech control catalog must contain at most ${MAX_SPEECH_CONTROL_FACTS} facts`,
  );
}

function factSizeBytes(fact: SpeechControlFact): number {
  const serialized = JSON.stringify(fact);
  if (serialized === undefined) throw new TypeError("Speech control fact cannot be serialized");
  return utf8ByteLength(serialized);
}

function snapshotEnvelopeSizeBytes(fetchedAt: number, validUntil: number): number {
  return utf8ByteLength(
    JSON.stringify({
      version: 1,
      fetchedAt: new Date(fetchedAt).toISOString(),
      validUntil: new Date(validUntil).toISOString(),
      facts: [],
    }),
  );
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 0x7f) bytes += 1;
    else if (unit <= 0x7ff) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
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
