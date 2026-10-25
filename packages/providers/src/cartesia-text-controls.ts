import type { TtsTextControl } from "@tvic/core";

export function renderCartesiaText(
  text: string,
  controls: readonly TtsTextControl[],
  maxBytes: number,
): string {
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
    let selected: TtsTextControl | undefined;
    let selectedAt = text.length;
    for (const control of controls) {
      const foundAt = text.indexOf(control.match, cursor);
      if (foundAt >= 0 && foundAt < selectedAt) {
        selected = control;
        selectedAt = foundAt;
      }
    }
    if (!selected) {
      append(escapeCartesiaText(text.slice(cursor)));
      cursor = text.length;
      break;
    }

    append(escapeCartesiaText(text.slice(cursor, selectedAt)));
    const matched = text.slice(selectedAt, selectedAt + selected.match.length);
    if (selected.type === "spell") {
      append(`<spell>${escapeCartesiaText(matched)}</spell>`);
    } else {
      append(`${escapeCartesiaText(matched)}<break time="${selected.durationMs}ms"/>`);
    }
    cursor = selectedAt + selected.match.length;
  }

  return parts.join("");
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
