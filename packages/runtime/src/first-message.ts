import { TvicThrowableError, validationError } from "@tvic/core";

export const MAX_FIRST_MESSAGE_CODE_POINTS = 1_000;

export function validateFirstMessage(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    return configurationError("firstMessage must be a non-empty string");
  }
  if (Array.from(value).length > MAX_FIRST_MESSAGE_CODE_POINTS) {
    return configurationError(
      `firstMessage must contain at most ${MAX_FIRST_MESSAGE_CODE_POINTS} Unicode code points`,
    );
  }
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    return configurationError("firstMessage must not contain control characters");
  }
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (Number.isNaN(nextCodeUnit) || nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) {
        return configurationError("firstMessage must contain valid Unicode text");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return configurationError("firstMessage must contain valid Unicode text");
    }
  }
  return value;
}

function configurationError(message: string): never {
  throw TvicThrowableError.from(validationError("voice_runtime.invalid_config", message));
}
