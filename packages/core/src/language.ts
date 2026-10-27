/**
 * Returns the canonical form of a BCP-47 language tag, or `undefined` when the
 * input is not a valid tag. This helper deliberately does not trim or reject
 * special application-level values; callers own those policy decisions.
 */
export function canonicalizeLanguageTag(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return Intl.getCanonicalLocales(value)[0];
  } catch {
    return undefined;
  }
}

export type StrictLanguageTagNormalization =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: "empty" | "mode_value" | "invalid_tag" };

/** Trims and canonicalizes a caller-selected BCP-47 tag, rejecting STT mode words. */
export function normalizeStrictLanguageTag(value: unknown): StrictLanguageTagNormalization {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, reason: "empty" };
  }
  const tag = value.trim();
  if (tag.toLowerCase() === "multi" || tag.toLowerCase() === "unknown") {
    return { ok: false, reason: "mode_value" };
  }
  const canonical = canonicalizeLanguageTag(tag);
  return canonical ? { ok: true, value: canonical } : { ok: false, reason: "invalid_tag" };
}

/** Returns the primary language subtag of a valid BCP-47 language tag. */
export function primaryLanguageSubtag(language: string): string {
  return new Intl.Locale(language).language.toLowerCase();
}

/** Returns a BCP-47 tag followed by its progressively broader parent tags. */
export function languageTagCandidates(language: string): readonly string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const canonical = canonicalizeLanguageTag(language);
  const rawPrimary = language.split("-", 1)[0]?.toLowerCase();
  const canonicalPrimary = canonical?.split("-", 1)[0]?.toLowerCase();
  const rawAlias =
    canonical !== undefined && rawPrimary !== canonicalPrimary ? language : undefined;
  for (const startingTag of [rawAlias, canonical ?? language]) {
    if (startingTag === undefined) continue;
    let candidate = startingTag;
    while (true) {
      if (!seen.has(candidate)) {
        seen.add(candidate);
        candidates.push(candidate);
      }
      const separator = candidate.lastIndexOf("-");
      if (separator < 0) break;
      candidate = candidate.slice(0, separator);
    }
  }
  return candidates;
}

export type LanguageStringMapNormalization =
  | { readonly ok: true; readonly value: Readonly<Record<string, string>> }
  | {
      readonly ok: false;
      readonly reason:
        | "invalid_object"
        | "too_many_entries"
        | "invalid_language"
        | "duplicate_language"
        | "invalid_value";
      readonly language?: string;
    };

/** Canonicalizes language keys and validates non-empty string values. */
export function normalizeLanguageStringMap(
  input: unknown,
  maxEntries: number,
): LanguageStringMapNormalization {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 0) {
    throw new RangeError("maxEntries must be a non-negative safe integer");
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, reason: "invalid_object" };
  }

  let entryCount = 0;
  for (const language in input) {
    if (Object.prototype.hasOwnProperty.call(input, language) && ++entryCount > maxEntries) {
      return { ok: false, reason: "too_many_entries" };
    }
  }

  const result: Record<string, string> = {};
  for (const [rawLanguage, voice] of Object.entries(input)) {
    const language = canonicalizeLanguageTag(rawLanguage);
    if (!language) return { ok: false, reason: "invalid_language", language: rawLanguage };
    if (Object.prototype.hasOwnProperty.call(result, language)) {
      return { ok: false, reason: "duplicate_language", language };
    }
    if (typeof voice !== "string" || voice.trim().length === 0) {
      return { ok: false, reason: "invalid_value", language: rawLanguage };
    }
    Object.defineProperty(result, language, {
      configurable: false,
      enumerable: true,
      value: voice,
      writable: false,
    });
  }
  return { ok: true, value: Object.freeze(result) };
}
