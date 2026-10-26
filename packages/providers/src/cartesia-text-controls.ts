import type { TtsTextControl } from "@tvic/core";

export function renderCartesiaText(
  text: string,
  controls: readonly TtsTextControl[],
  maxBytes: number,
): string {
  assertCartesiaTextFits(text, controls, maxBytes);
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
      append(escapeCartesiaText(text.slice(start, end)));
      return;
    }
    const matched = escapeCartesiaText(text.slice(start, end));
    if (control.type === "spell") {
      append(`<spell>${matched}</spell>`);
    } else {
      append(`${matched}<break time="${control.durationMs}ms"/>`);
    }
  });

  return parts.join("");
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

  forEachCartesiaTextControl(text, controls, (start, end, control) => {
    countEscapedRange(start, end);
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
  let matchedThrough = 0;
  forEachCartesiaTextControl(text, controls, (_start, end, control) => {
    if (control) matchedThrough = end;
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

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function escapeCartesiaText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
