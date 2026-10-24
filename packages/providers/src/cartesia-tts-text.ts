import type {
  TtsPronunciationDictionaryReference,
  TtsTextNormalization,
  TtsTextOperation,
  TtsTextPart,
} from "@tvic/core";

const MAX_TEXT_PARTS = 65;
const MAX_TEXT_CODE_POINTS = 20_000;
const MAX_TAG_TEXT_CODE_POINTS = 128;
const MAX_PAUSE_MS = 3_000;

export function serializeCartesiaTtsText(parts: readonly TtsTextPart[]): string {
  if (!Array.isArray(parts) || parts.length > MAX_TEXT_PARTS) {
    throw new TypeError("Cartesia typed text parts exceed the supported limit");
  }

  let codePoints = 0;
  const output: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === null || typeof part !== "object") {
      throw new TypeError("Cartesia typed text part must be an object");
    }
    switch (part.type) {
      case "text":
        validateText(part.text, false);
        codePoints += Array.from(part.text).length;
        output.push(escapeXmlText(part.text));
        break;
      case "spell":
        validateText(part.text, true);
        codePoints += Array.from(part.text).length;
        output.push(`<spell>${escapeXmlText(part.text)}</spell>`);
        break;
      case "pause":
        if (
          !Number.isSafeInteger(part.durationMs) ||
          part.durationMs < 0 ||
          part.durationMs > MAX_PAUSE_MS
        ) {
          throw new TypeError("Cartesia pause duration must be an integer from 0 to 3000ms");
        }
        if (parts[index - 1]?.type === "spell") {
          throw new TypeError("Cartesia spell and pause controls cannot be adjacent");
        }
        output.push(`<break time="${part.durationMs}ms"/>`);
        break;
      case "phoneme":
        throw new TypeError("Cartesia does not support typed phoneme operations");
      default:
        throw new TypeError("Cartesia typed text part type is unsupported");
    }
    if (codePoints > MAX_TEXT_CODE_POINTS) {
      throw new TypeError("Cartesia typed text exceeds the supported code point limit");
    }
  }
  return output.join("");
}

export function serializeCartesiaPlainText(text: string): string {
  if (typeof text !== "string" || /\p{Cc}/u.test(text)) {
    throw new TypeError("Cartesia text must be a control-free string");
  }
  return escapeXmlText(text);
}

export function cartesiaSupportsTtsTextOperations(
  model: string,
  operations: readonly TtsTextOperation[],
): boolean {
  if (!cartesiaSupportsTypedParts(model) || !Array.isArray(operations) || operations.length > 32) {
    return false;
  }

  const spellTargets = new Set<string>();
  const pauseTargets = new Set<string>();
  for (const operation of operations) {
    if (operation === null || typeof operation !== "object") return false;
    if (operation.type === "spell") spellTargets.add(operation.match);
    else if (operation.type === "pause_after") pauseTargets.add(operation.match);
    else return false;
  }
  return [...spellTargets].every((match) => !pauseTargets.has(match));
}

export function cartesiaSupportsTypedParts(model: string): boolean {
  return isSonic3Model(model);
}

export function cartesiaSupportsTextNormalization(
  normalization: TtsTextNormalization,
  model: string,
): boolean {
  if (!isSonic3Model(model)) return false;
  if (normalization === "auto" || normalization === "off") return true;
  if (normalization === "on") return false;
  return (
    typeof normalization === "object" && normalization !== null && normalization.mode === "locale"
  );
}

export function cartesiaTextNormalizationValue(normalization: TtsTextNormalization): string {
  if (normalization === "auto" || normalization === "off") return normalization;
  if (normalization === "on") {
    throw new TypeError('Cartesia text normalization supports "auto", "off", or a locale');
  }
  return normalization.locale;
}

export function cartesiaSupportsPronunciationDictionaries(
  dictionaries: readonly TtsPronunciationDictionaryReference[],
  model: string,
): boolean {
  return (
    dictionaries.length === 0 ||
    (isSonic3Model(model) &&
      dictionaries.length === 1 &&
      dictionaries.every((dictionary) => dictionary.version === undefined))
  );
}

function isSonic3Model(model: string): boolean {
  return /^sonic-3(?:$|\.)/.test(model);
}

function validateText(text: string, requireNonEmpty: boolean): void {
  if (typeof text !== "string" || (requireNonEmpty && text.length === 0)) {
    throw new TypeError("Cartesia text part must be a valid string");
  }
  if (/\p{Cc}/u.test(text)) {
    throw new TypeError("Cartesia text parts must not include control characters");
  }
  if (requireNonEmpty && Array.from(text).length > MAX_TAG_TEXT_CODE_POINTS) {
    throw new TypeError("Cartesia spell text exceeds 128 code points");
  }
}

function escapeXmlText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
