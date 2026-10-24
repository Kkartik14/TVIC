import {
  countUnicodeCodePoints,
  STT_ERROR_CODES,
  TvicThrowableError,
  validationError,
} from "@tvic/core";
import type { SpeechToTextProvider, SttLanguagePolicy, SttTurnTakingProfile } from "@tvic/core";

export interface SttCallSelection {
  readonly languagePolicy?: SttLanguagePolicy;
  readonly turnTakingProfile?: SttTurnTakingProfile;
  readonly vocabulary?: readonly string[];
  readonly agentContextUpdates: boolean;
}

export interface SttCallSelectionInput {
  readonly model?: string;
  readonly sttLanguage?: string;
  readonly sttLanguagePolicy?: SttLanguagePolicy;
  readonly vocabulary?: readonly string[];
  readonly sttConversationContext?: boolean;
  readonly turnTakingProfile?: SttTurnTakingProfile;
}

const MAX_STT_LANGUAGE_HINTS = 16;
const MAX_STT_VOCABULARY_TERMS = 256;
const MAX_STT_VOCABULARY_TERM_CHARS = 256;

export function resolveSttCallSelection(
  provider: SpeechToTextProvider,
  input: SttCallSelectionInput,
): SttCallSelection {
  if (
    input.sttConversationContext !== undefined &&
    typeof input.sttConversationContext !== "boolean"
  ) {
    invalidRequest("sttConversationContext must be a boolean");
  }
  if (input.sttLanguage !== undefined && input.sttLanguagePolicy !== undefined) {
    invalidRequest("sttLanguage and sttLanguagePolicy cannot be combined");
  }

  const languagePolicy = resolveLanguagePolicy(input);
  if (languagePolicy !== undefined) {
    if (provider.supportsSttLanguagePolicy === undefined) {
      invalidRequest(`Provider ${provider.name} does not declare STT language-policy support`);
    }
    if (!provider.supportsSttLanguagePolicy(languagePolicy, input.model)) {
      invalidRequest(`Provider ${provider.name} does not support the selected STT language policy`);
    }
  }

  const turnTakingProfile = normalizeTurnTakingProfile(input.turnTakingProfile);
  if (turnTakingProfile !== undefined) {
    if (provider.supportsSttTurnTakingProfile === undefined) {
      invalidRequest(`Provider ${provider.name} does not declare STT turn-profile support`);
    }
    if (!provider.supportsSttTurnTakingProfile(turnTakingProfile, input.model)) {
      invalidRequest(
        `Provider ${provider.name} does not support STT turn profile ${turnTakingProfile} for model ${input.model ?? "default"}`,
      );
    }
  }

  const vocabulary = normalizeSttVocabulary(input.vocabulary);
  if (vocabulary !== undefined) {
    if (provider.supportsSttVocabulary === undefined) {
      invalidRequest(`Provider ${provider.name} does not declare STT vocabulary support`);
    }
    if (!provider.supportsSttVocabulary(vocabulary, input.model)) {
      invalidRequest(
        `Provider ${provider.name} does not support STT vocabulary for the selected model`,
      );
    }
  }

  if (input.sttConversationContext === true) {
    if (provider.supportsSttAgentContext === undefined) {
      invalidRequest(`Provider ${provider.name} does not declare STT agent context support`);
    }
    if (!provider.supportsSttAgentContext(input.model)) {
      invalidRequest(`Provider ${provider.name} does not support STT agent context updates`);
    }
  }

  return Object.freeze({
    ...(languagePolicy !== undefined ? { languagePolicy } : {}),
    ...(turnTakingProfile !== undefined ? { turnTakingProfile } : {}),
    ...(vocabulary !== undefined ? { vocabulary } : {}),
    agentContextUpdates: input.sttConversationContext === true,
  });
}

function normalizeTurnTakingProfile(value: unknown): SttTurnTakingProfile | undefined {
  if (value === undefined) return undefined;
  if (value === "latency" || value === "balanced" || value === "accuracy") return value;
  return invalidRequest("STT turn profile must be latency, balanced, or accuracy");
}

function resolveLanguagePolicy(input: SttCallSelectionInput): SttLanguagePolicy | undefined {
  if (input.sttLanguagePolicy !== undefined) {
    return normalizeLanguagePolicy(input.sttLanguagePolicy);
  }
  if (input.sttLanguage === undefined) return undefined;
  return Object.freeze({ mode: "fixed", language: normalizeLanguage(input.sttLanguage) });
}

function normalizeLanguagePolicy(value: SttLanguagePolicy): SttLanguagePolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalidRequest("sttLanguagePolicy must be an object");
  }

  if (value.mode === "auto") {
    if (Object.keys(value).some((key) => key !== "mode")) {
      invalidRequest("Automatic STT language policy accepts only the mode field");
    }
    return Object.freeze({ mode: "auto" });
  }

  if (value.mode === "fixed") {
    if (
      Object.keys(value).some((key) => key !== "mode" && key !== "language") ||
      typeof value.language !== "string"
    ) {
      invalidRequest("Fixed STT language policy requires only a language field");
    }
    return Object.freeze({ mode: "fixed", language: normalizeLanguage(value.language) });
  }

  if (value.mode === "hints") {
    if (
      Object.keys(value).some(
        (key) => key !== "mode" && key !== "languages" && key !== "strictness",
      ) ||
      !Array.isArray(value.languages) ||
      (value.strictness !== undefined && value.strictness !== "best_effort")
    ) {
      invalidRequest(
        `STT language hints require one to ${MAX_STT_LANGUAGE_HINTS} languages and optional best_effort strictness`,
      );
    }
    if (value.languages.length === 0) {
      invalidRequest("STT language hints require at least one language hint");
    }
    if (value.languages.length > MAX_STT_LANGUAGE_HINTS) {
      invalidRequest(`STT language hints accept at most ${MAX_STT_LANGUAGE_HINTS} languages`);
    }
    const languages: string[] = [];
    const seen = new Set<string>();
    for (const languageValue of value.languages) {
      const language = normalizeLanguage(languageValue);
      const key = language.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      languages.push(language);
    }
    if (languages.length === 0)
      invalidRequest("STT language hints require at least one language hint");
    return Object.freeze({
      mode: "hints",
      languages: Object.freeze(languages),
      ...(value.strictness !== undefined ? { strictness: value.strictness } : {}),
    });
  }

  return invalidRequest("sttLanguagePolicy mode must be fixed, auto, or hints");
}

function normalizeLanguage(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return invalidRequest("STT language must be a non-empty BCP-47 language tag");
  }
  const normalized = value.trim();
  if (normalized.toLowerCase() === "multi" || normalized.toLowerCase() === "unknown") {
    return invalidRequest("STT mode values multi and unknown are not valid BCP-47 language tags");
  }
  try {
    const [canonical] = Intl.getCanonicalLocales(normalized);
    if (!canonical) throw new RangeError("missing canonical language tag");
    return canonical;
  } catch {
    return invalidRequest(`STT language ${normalized} is not a valid BCP-47 language tag`);
  }
}

export function normalizeSttVocabulary(
  input: readonly string[] | undefined,
): readonly string[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length > MAX_STT_VOCABULARY_TERMS) {
    return invalidRequest(
      `STT vocabulary must contain no more than ${MAX_STT_VOCABULARY_TERMS} terms`,
    );
  }
  if (input.length === 0) return undefined;

  const vocabulary: string[] = [];
  const seen = new Set<string>();
  for (const value of input) {
    if (typeof value !== "string") invalidRequest("STT vocabulary terms must be strings");
    const term = value.trim();
    if (term.length === 0) invalidRequest("STT vocabulary terms cannot be empty");
    if (
      term.length > MAX_STT_VOCABULARY_TERM_CHARS * 2 ||
      countUnicodeCodePoints(term) > MAX_STT_VOCABULARY_TERM_CHARS ||
      /[\u0000-\u001f\u007f]/u.test(term)
    ) {
      invalidRequest(
        `STT vocabulary terms must contain at most ${MAX_STT_VOCABULARY_TERM_CHARS} characters and no control characters`,
      );
    }
    if (seen.has(term)) continue;
    seen.add(term);
    vocabulary.push(term);
  }
  return Object.freeze(vocabulary);
}

function invalidRequest(message: string): never {
  throw TvicThrowableError.from(validationError(STT_ERROR_CODES.invalidRequest, message));
}
