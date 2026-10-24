export type TtsTextNormalization =
  | "auto"
  | "on"
  | "off"
  | { readonly mode: "locale"; readonly locale: string };

export interface TtsPronunciationDictionaryReference {
  readonly id: string;
  readonly version?: string;
}

const MAX_DICTIONARIES = 3;
const MAX_DICTIONARY_ID_LENGTH = 256;
const MAX_DICTIONARY_VERSION_LENGTH = 128;

export function validateTtsTextNormalization(value: unknown): TtsTextNormalization {
  if (value === "auto" || value === "on" || value === "off") return value;
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).mode !== "locale"
  ) {
    throw new TypeError('TTS text normalization must be "auto", "on", "off", or a locale setting');
  }
  const locale = (value as Record<string, unknown>).locale;
  if (typeof locale !== "string" || locale.trim() !== locale || locale.length === 0) {
    throw new TypeError("TTS normalization locale must be a valid BCP-47 tag");
  }
  try {
    const [canonicalLocale] = Intl.getCanonicalLocales(locale);
    if (canonicalLocale !== undefined) {
      return Object.freeze({ mode: "locale", locale: canonicalLocale });
    }
  } catch {
    throw new TypeError("TTS normalization locale must be a valid BCP-47 tag");
  }
  throw new TypeError("TTS normalization locale must be a valid BCP-47 tag");
}

export function validateTtsPronunciationDictionaries(
  value: unknown,
): readonly TtsPronunciationDictionaryReference[] {
  if (!Array.isArray(value) || value.length > MAX_DICTIONARIES) {
    throw new TypeError(
      `TTS pronunciation dictionaries must be an array of at most ${MAX_DICTIONARIES} references`,
    );
  }

  const seenIds = new Set<string>();
  const references: TtsPronunciationDictionaryReference[] = [];
  for (const entry of value as readonly unknown[]) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new TypeError("TTS pronunciation dictionary reference must be an object");
    }
    const reference = entry as Record<string, unknown>;
    const id = reference.id;
    const version = reference.version;
    if (!validIdentifier(id, MAX_DICTIONARY_ID_LENGTH)) {
      throw new TypeError("TTS pronunciation dictionary identifier is invalid");
    }
    if (version !== undefined && !validIdentifier(version, MAX_DICTIONARY_VERSION_LENGTH)) {
      throw new TypeError("TTS pronunciation dictionary version identifier is invalid");
    }
    if (seenIds.has(id)) {
      throw new TypeError("TTS pronunciation dictionary references must not contain duplicate IDs");
    }
    seenIds.add(id);
    references.push(Object.freeze({ id, ...(version !== undefined ? { version } : {}) }));
  }
  return Object.freeze(references);
}

function validIdentifier(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value &&
    !/\p{Cc}/u.test(value)
  );
}
