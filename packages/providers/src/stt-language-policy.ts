import type { SttLanguagePolicy, SttOpenRequest } from "@tvic/core";
import { MAX_STT_LANGUAGE_HINTS, STT_ERROR_CODES, TvicThrowableError } from "@tvic/core";

import { validationError } from "./common.js";

export function requestLanguagePolicy(
  request: SttOpenRequest,
  provider: string,
): SttLanguagePolicy | undefined {
  if (request.language !== undefined && request.languagePolicy !== undefined) {
    throw TvicThrowableError.from(
      validationError(
        STT_ERROR_CODES.invalidRequest,
        "STT language and languagePolicy cannot be combined",
        { provider },
      ),
    );
  }
  const policy =
    request.languagePolicy ??
    (request.language !== undefined
      ? { mode: "fixed" as const, language: request.language }
      : undefined);
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
  if (typeof language !== "string" || language.trim().length === 0)
    return invalidLanguage(provider);
  const tag = language.trim();
  if (tag.toLowerCase() === "multi" || tag.toLowerCase() === "unknown") {
    return invalidLanguage(provider);
  }
  try {
    const [canonical] = Intl.getCanonicalLocales(tag);
    return canonical ?? invalidLanguage(provider);
  } catch {
    return invalidLanguage(provider);
  }
}

export function primaryLanguage(language: string): string {
  return new Intl.Locale(language).language.toLowerCase();
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
