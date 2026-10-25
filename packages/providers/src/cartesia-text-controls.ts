import type { TtsTextControl } from "@tvic/core";

export function renderCartesiaText(
  text: string,
  controls: readonly TtsTextControl[],
  maxBytes: number,
): string {
  assertCartesiaTextFits(text, controls, maxBytes);
  const parts: string[] = [];
  let outputBytes = 0;
  let cursor = 0;

  const append = (value: string): void => {
    outputBytes += Buffer.byteLength(value, "utf8");
    if (outputBytes > maxBytes)
      throw new TypeError("Cartesia serialized transcript exceeded its byte limit");
    parts.push(value);
  };

  while (cursor < text.length) {
    const next = findNextControl(text, controls, cursor);
    if (!next) {
      append(escapeCartesiaText(text.slice(cursor)));
      cursor = text.length;
      break;
    }

    append(escapeCartesiaText(text.slice(cursor, next.index)));
    const matched = text.slice(next.index, next.index + next.control.match.length);
    if (next.control.type === "spell") {
      append(`<spell>${escapeCartesiaText(matched)}</spell>`);
    } else {
      append(`${escapeCartesiaText(matched)}<break time="${next.control.durationMs}ms"/>`);
    }
    cursor = next.index + next.control.match.length;
  }

  return parts.join("");
}

function assertCartesiaTextFits(
  text: string,
  controls: readonly TtsTextControl[],
  maxBytes: number,
): void {
  if (text.length > maxBytes) {
    throw new TypeError("Cartesia serialized transcript exceeded its byte limit");
  }

  let outputBytes = 0;
  let cursor = 0;
  const countEscapedRange = (start: number, end: number): void => {
    for (let index = start; index < end; ) {
      const codePoint = text.codePointAt(index)!;
      outputBytes += escapedCodePointByteLength(codePoint);
      if (outputBytes > maxBytes) {
        throw new TypeError("Cartesia serialized transcript exceeded its byte limit");
      }
      index += codePoint > 0xffff ? 2 : 1;
    }
  };

  while (cursor < text.length) {
    const next = findNextControl(text, controls, cursor);
    if (!next) {
      countEscapedRange(cursor, text.length);
      return;
    }

    countEscapedRange(cursor, next.index);
    const matchedEnd = next.index + next.control.match.length;
    if (next.control.type === "spell") {
      outputBytes += 15;
    } else {
      outputBytes += `<break time="${next.control.durationMs}ms"/>`.length;
    }
    countEscapedRange(next.index, matchedEnd);
    if (outputBytes > maxBytes) {
      throw new TypeError("Cartesia serialized transcript exceeded its byte limit");
    }
    cursor = matchedEnd;
  }
}

function findNextControl(
  text: string,
  controls: readonly TtsTextControl[],
  cursor: number,
): { readonly control: TtsTextControl; readonly index: number } | undefined {
  let selected: TtsTextControl | undefined;
  let selectedAt = text.length;
  for (const control of controls) {
    const foundAt = text.indexOf(control.match, cursor);
    if (foundAt >= 0 && foundAt < selectedAt) {
      selected = control;
      selectedAt = foundAt;
    }
  }
  return selected ? { control: selected, index: selectedAt } : undefined;
}

function escapedCodePointByteLength(codePoint: number): number {
  if (codePoint === 0x26) return 5;
  if (codePoint === 0x3c || codePoint === 0x3e) return 4;
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

export function splitCartesiaTextAtControlBoundary(
  text: string,
  controls: readonly TtsTextControl[],
): { readonly ready: string; readonly pending: string } {
  let pendingLength = 0;
  for (const control of controls) {
    const maxPrefixLength = Math.min(text.length, control.match.length - 1);
    for (let length = maxPrefixLength; length > pendingLength; length -= 1) {
      if (text.endsWith(control.match.slice(0, length))) {
        pendingLength = length;
        break;
      }
    }
  }
  return {
    ready: text.slice(0, text.length - pendingLength),
    pending: text.slice(text.length - pendingLength),
  };
}

function escapeCartesiaText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
