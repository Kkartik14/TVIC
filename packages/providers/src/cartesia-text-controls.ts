import type { TtsTextControl } from "@tvic/core";
import { TVIC_ERROR_CODES, TvicThrowableError } from "@tvic/core";

import { providerError } from "./common.js";

const CARTESIA_MARKUP_PATTERN =
  /<\s*\/?\s*(spell|break|emotion|volume|speed)\b[^<>]*>|<<[^<>]*\|[^<>]*>>|\[laughter\]/i;
const CARTESIA_MARKUP_NAMES = ["spell", "break", "emotion", "volume", "speed"] as const;

export function renderCartesiaText(
  text: string,
  controls: readonly TtsTextControl[],
  maxBytes: number,
  transcriptMarkup: "passthrough" | "reject" = "passthrough",
): string {
  assertCartesiaTextFits(text, controls, maxBytes);
  if (transcriptMarkup === "reject") assertNoCartesiaMarkupInSourceText(text);
  if (controls.length === 0) return text;
  const parts: string[] = [];
  let outputBytes = 0;

  const append = (value: string): void => {
    outputBytes += Buffer.byteLength(value, "utf8");
    if (outputBytes > maxBytes)
      throw new TypeError("Cartesia serialized transcript exceeded its byte limit");
    parts.push(value);
  };

  forEachCartesiaTextControl(text, controls, (start, end, control) => {
    if (!control) {
      append(text.slice(start, end));
      return;
    }
    const matched = text.slice(start, end);
    if (control.type === "spell") {
      append(`<spell>${matched}</spell>`);
    } else {
      append(`${matched}<break time="${control.durationMs}ms"/>`);
    }
  });

  return parts.join("");
}

function assertNoCartesiaMarkupInSourceText(text: string): void {
  const match = CARTESIA_MARKUP_PATTERN.exec(text);
  if (!match) return;
  throw TvicThrowableError.from(
    providerError(
      TVIC_ERROR_CODES.providerInputRejected,
      "Cartesia transcript text cannot contain provider markup; use typed text controls for spelling and pauses",
      {
        provider: "cartesia",
        retriable: false,
        metadata: {
          tagName:
            match[1]?.toLowerCase() ??
            (match[0].toLowerCase() === "[laughter]" ? "laughter" : "inline_phoneme"),
        },
      },
    ),
  );
}

function assertCartesiaTextFits(
  text: string,
  controls: readonly TtsTextControl[],
  maxBytes: number,
): void {
  if (controls.length === 0) {
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new TypeError("Cartesia serialized transcript exceeded its byte limit");
    }
    return;
  }
  if (text.length > maxBytes) {
    throw new TypeError("Cartesia serialized transcript exceeded its byte limit");
  }

  let outputBytes = 0;
  const countRange = (start: number, end: number): void => {
    for (let index = start; index < end; ) {
      const codePoint = text.codePointAt(index)!;
      outputBytes += utf8CodePointByteLength(codePoint);
      if (outputBytes > maxBytes) {
        throw new TypeError("Cartesia serialized transcript exceeded its byte limit");
      }
      index += codePoint > 0xffff ? 2 : 1;
    }
  };

  forEachCartesiaTextControl(text, controls, (start, end, control) => {
    countRange(start, end);
    if (control?.type === "spell") outputBytes += 15;
    if (control?.type === "pause") {
      outputBytes += `<break time="${control.durationMs}ms"/>`.length;
    }
    if (outputBytes > maxBytes) {
      throw new TypeError("Cartesia serialized transcript exceeded its byte limit");
    }
  });
}

function forEachCartesiaTextControl(
  text: string,
  controls: readonly TtsTextControl[],
  visit: (start: number, end: number, control: TtsTextControl | undefined) => void,
): void {
  const nextMatches = controls.map((control) => text.indexOf(control.match));
  let cursor = 0;
  while (cursor < text.length) {
    let selectedIndex = -1;
    let selectedAt = text.length;
    for (let index = 0; index < nextMatches.length; index += 1) {
      let foundAt = nextMatches[index]!;
      if (foundAt >= 0 && foundAt < cursor) {
        foundAt = text.indexOf(controls[index]!.match, cursor);
        nextMatches[index] = foundAt;
      }
      if (foundAt >= 0 && foundAt < selectedAt) {
        selectedIndex = index;
        selectedAt = foundAt;
      }
    }

    if (selectedIndex < 0) {
      visit(cursor, text.length, undefined);
      return;
    }

    if (selectedAt > cursor) visit(cursor, selectedAt, undefined);
    const control = controls[selectedIndex]!;
    const matchedEnd = selectedAt + control.match.length;
    visit(selectedAt, matchedEnd, control);
    cursor = matchedEnd;
    nextMatches[selectedIndex] = text.indexOf(control.match, cursor);
  }
}

function utf8CodePointByteLength(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

export function splitCartesiaTextAtControlBoundary(
  text: string,
  controls: readonly TtsTextControl[],
): { readonly ready: string; readonly pending: string } {
  let matchedThrough = 0;
  const matchedRanges: { readonly start: number; readonly end: number }[] = [];
  forEachCartesiaTextControl(text, controls, (start, end, control) => {
    if (control) {
      matchedThrough = end;
      matchedRanges.push({ start, end });
    }
  });

  let pendingLength = 0;
  for (const control of controls) {
    const maxPrefixLength = Math.min(text.length, control.match.length - 1);
    for (let length = maxPrefixLength; length > pendingLength; length -= 1) {
      const prefixStart = text.length - length;
      if (prefixStart >= matchedThrough && text.endsWith(control.match.slice(0, length))) {
        pendingLength = length;
        break;
      }
    }
  }
  pendingLength = Math.max(
    pendingLength,
    pendingCartesiaMarkupPrefixLength(text.slice(matchedThrough)),
  );
  const shouldHoldMarkupPrefix = (length: number): boolean => {
    if (length === 0) return false;
    const prefixStart = text.length - length;
    return (
      prefixStart >= matchedThrough ||
      matchedRanges.some((range) => prefixStart < range.start && range.end > prefixStart)
    );
  };
  const inlinePhonemePrefixLength = pendingInlinePhonemePrefixLength(text);
  const laughterPrefixLength = pendingCartesiaLaughterPrefixLength(text);
  const trailingMarkupPrefixLength = pendingCartesiaMarkupPrefixLength(text);
  if (shouldHoldMarkupPrefix(inlinePhonemePrefixLength)) {
    pendingLength = Math.max(pendingLength, inlinePhonemePrefixLength);
  }
  if (shouldHoldMarkupPrefix(laughterPrefixLength)) {
    pendingLength = Math.max(pendingLength, laughterPrefixLength);
  }
  if (trailingMarkupPrefixLength > 1 && shouldHoldMarkupPrefix(trailingMarkupPrefixLength)) {
    pendingLength = Math.max(pendingLength, trailingMarkupPrefixLength);
  }
  let readyLength = text.length - pendingLength;
  if (
    readyLength === text.length &&
    readyLength > 0 &&
    isHighSurrogate(text.charCodeAt(readyLength - 1))
  ) {
    readyLength -= 1;
  } else if (
    readyLength > 0 &&
    readyLength < text.length &&
    isHighSurrogate(text.charCodeAt(readyLength - 1)) &&
    isLowSurrogate(text.charCodeAt(readyLength))
  ) {
    readyLength -= 1;
  }
  return {
    ready: text.slice(0, readyLength),
    pending: text.slice(readyLength),
  };
}

function pendingCartesiaMarkupPrefixLength(text: string): number {
  const normalizedText = text.toLowerCase();
  const laughterTag = "[laughter]";
  for (
    let length = Math.min(normalizedText.length, laughterTag.length - 1);
    length > 0;
    length -= 1
  ) {
    if (normalizedText.endsWith(laughterTag.slice(0, length))) return length;
  }
  const opening = text.lastIndexOf("<");
  if (opening < 0) return 0;
  const suffix = text.slice(opening);
  if (CARTESIA_MARKUP_PATTERN.test(suffix)) return 0;
  const opener = /^<\s*\/?\s*/u.exec(suffix);
  if (!opener) return 0;
  const remainder = suffix.slice(opener[0].length);
  const nameMatch = /^[a-z][a-z0-9_-]*/iu.exec(remainder);
  if (!nameMatch) return remainder.length === 0 ? suffix.length : 0;
  const name = nameMatch[0].toLowerCase();
  const tail = remainder.slice(nameMatch[0].length);
  if (CARTESIA_MARKUP_NAMES.some((supported) => supported.startsWith(name))) {
    if (tail.length === 0) return suffix.length;
  }
  if (
    CARTESIA_MARKUP_NAMES.includes(name as (typeof CARTESIA_MARKUP_NAMES)[number]) &&
    /^[\s/]/u.test(tail) &&
    !tail.includes(">")
  ) {
    return suffix.length;
  }
  return 0;
}

function pendingInlinePhonemePrefixLength(text: string): number {
  const inlinePhonemeStart = text.lastIndexOf("<<");
  if (inlinePhonemeStart <= text.lastIndexOf(">>")) return 0;
  const phonemePrefix = text.slice(inlinePhonemeStart + 2);
  if (phonemePrefix.includes("|")) return text.length - inlinePhonemeStart;
  if (/[<>\s]/u.test(phonemePrefix)) return 0;
  return text.length - inlinePhonemeStart;
}

function pendingCartesiaLaughterPrefixLength(text: string): number {
  const normalizedText = text.toLowerCase();
  const laughterTag = "[laughter]";
  for (
    let length = Math.min(normalizedText.length, laughterTag.length - 1);
    length > 0;
    length -= 1
  ) {
    if (normalizedText.endsWith(laughterTag.slice(0, length))) return length;
  }
  return 0;
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}
