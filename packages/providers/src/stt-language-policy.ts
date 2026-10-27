import type { SttLanguagePolicy, SttOpenRequest } from "@tvic/core";
import {
  MAX_STT_LANGUAGE_HINTS,
  normalizeStrictLanguageTag,
  primaryLanguageSubtag,
  STT_ERROR_CODES,
  TvicThrowableError,
} from "@tvic/core";

import { validationError } from "./common.js";

export const MAX_STT_RAW_LANGUAGE_LENGTH = 256;

export function requestLanguagePolicy(
  request: SttOpenRequest,
  provider: string,
): SttLanguagePolicy | undefined {
  if (
    request.language !== undefined &&
    (typeof request.language !== "string" ||
      request.language.length > MAX_STT_RAW_LANGUAGE_LENGTH ||
      /[\u0000-\u001f\u007f]/u.test(request.language))
  ) {
    return invalidLanguage(provider);
  }
  if (request.language !== undefined && request.languagePolicy !== undefined) {
    throw TvicThrowableError.from(
      validationError(
        STT_ERROR_CODES.invalidRequest,
        "STT language and languagePolicy cannot be combined",
        { provider },
      ),
    );
  }
  // `language` is the legacy raw provider hint. Only `languagePolicy` opts into
  // the normalized, capability-checked policy contract.
  const policy = request.languagePolicy;
  return policy === undefined ? undefined : normalizeLanguagePolicy(policy, provider);
}

export function normalizeLanguagePolicy(
  policy: SttLanguagePolicy,
  provider: string,
): SttLanguagePolicy {
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    return invalidPolicy(provider);
  }
  if (policy.mode === "auto") {
    if (Object.keys(policy).some((key) => key !== "mode")) return invalidPolicy(provider);
    return { mode: "auto" };
  }
  if (policy.mode === "fixed") {
    if (
      Object.keys(policy).some((key) => key !== "mode" && key !== "language") ||
      typeof policy.language !== "string"
    ) {
      return invalidPolicy(provider);
    }
    return { mode: "fixed", language: normalizeLanguageTag(policy.language, provider) };
  }
  if (policy.mode === "hints") {
    if (
      Object.keys(policy).some(
        (key) => key !== "mode" && key !== "languages" && key !== "strictness",
      ) ||
      !Array.isArray(policy.languages) ||
      policy.languages.length === 0 ||
      policy.languages.length > MAX_STT_LANGUAGE_HINTS ||
      (policy.strictness !== undefined && policy.strictness !== "best_effort")
    ) {
      return invalidPolicy(provider);
    }
    const languages = [
      ...new Set(policy.languages.map((language) => normalizeLanguageTag(language, provider))),
    ];
    return {
      mode: "hints",
      languages,
      ...(policy.strictness !== undefined ? { strictness: policy.strictness } : {}),
    };
  }
  return invalidPolicy(provider);
}

export function normalizeLanguageTag(language: string, provider: string): string {
  const normalized = normalizeStrictLanguageTag(language);
  return normalized.ok ? normalized.value : invalidLanguage(provider);
}

export function primaryLanguage(language: string): string {
  return primaryLanguageSubtag(language);
}

export function primaryLanguages(languages: readonly string[]): readonly string[] {
  return [...new Set(languages.map(primaryLanguage))];
}

export function assertSupportedLanguagePolicy(
  provider: string,
  policy: SttLanguagePolicy | undefined,
  model: string,
  supports: (policy: SttLanguagePolicy, model: string) => boolean,
): void {
  if (policy === undefined || supports(policy, model)) return;
  throw TvicThrowableError.from(
    validationError(
      STT_ERROR_CODES.invalidRequest,
      `${provider} does not support the selected STT language policy for model ${model}`,
      { provider, metadata: { model } },
    ),
  );
}

function invalidPolicy(provider: string): never {
  throw TvicThrowableError.from(
    validationError(STT_ERROR_CODES.invalidRequest, "STT language policy is invalid", { provider }),
  );
}

function invalidLanguage(provider: string): never {
  throw TvicThrowableError.from(
    validationError("stt.language_invalid", "STT language must be a valid BCP-47 tag", {
      provider,
    }),
  );
}
