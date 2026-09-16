import type { TtsAlignmentUnit } from "@tvic/core";

import {
  MAX_RUNTIME_TTS_ALIGNMENT_ARRAY_ENTRIES,
  MAX_RUNTIME_TTS_ALIGNMENT_TOKEN_BYTES,
  MAX_RUNTIME_TTS_ALIGNMENT_TOKENS,
} from "./pipeline-constants.js";
import { runtimeResourceLimitError, utf8ByteLength } from "./pipeline-resource-limits.js";
import type { ActiveTurnControl } from "./turn-state.js";

export function alignedTextForHistory(control: ActiveTurnControl): string {
  if (control.alignedUnit === "character") {
    return control.alignedTokens.join("").trim();
  }
  if (control.alignedUnit === "word") {
    return control.alignedTokens.join(" ").trim();
  }
  return "";
}

export function appendAlignedTokens(
  target: string[],
  incoming: readonly string[],
  unit: TtsAlignmentUnit,
  startMs: readonly number[],
  alignedCharacterStarts: Set<number>,
  currentBytes: number,
): number {
  if (
    incoming.length > MAX_RUNTIME_TTS_ALIGNMENT_ARRAY_ENTRIES ||
    startMs.length > MAX_RUNTIME_TTS_ALIGNMENT_ARRAY_ENTRIES
  ) {
    throw runtimeResourceLimitError(
      "TTS alignment event",
      "events",
      MAX_RUNTIME_TTS_ALIGNMENT_ARRAY_ENTRIES,
    );
  }
  if (
    target.length > MAX_RUNTIME_TTS_ALIGNMENT_TOKENS ||
    !Number.isSafeInteger(currentBytes) ||
    currentBytes > MAX_RUNTIME_TTS_ALIGNMENT_TOKEN_BYTES
  ) {
    throw runtimeResourceLimitError(
      "TTS alignment tokens",
      "events",
      MAX_RUNTIME_TTS_ALIGNMENT_TOKENS,
    );
  }

  const additions: string[] = [];
  const startsToAdd: number[] = [];
  if (unit === "character") {
    const startsSeenInEvent = new Set<number>();
    incoming.forEach((token, index) => {
      const start = startMs[index];
      if (
        start !== undefined &&
        (alignedCharacterStarts.has(start) || startsSeenInEvent.has(start))
      )
        return;
      if (start !== undefined) startsSeenInEvent.add(start);
      additions.push(token);
    });
    for (const start of startsSeenInEvent) {
      if (!alignedCharacterStarts.has(start)) startsToAdd.push(start);
    }
  } else {
    let overlap = Math.min(target.length, incoming.length);
    while (overlap > 0) {
      let matches = true;
      for (let index = 0; index < overlap; index += 1) {
        if (target[target.length - overlap + index] !== incoming[index]) {
          matches = false;
          break;
        }
      }
      if (matches) break;
      overlap -= 1;
    }
    for (let index = overlap; index < incoming.length; index += 1) {
      additions.push(incoming[index] as string);
    }
  }

  let addedBytes = 0;
  for (const token of additions) {
    const tokenBytes = utf8ByteLength(token);
    addedBytes += tokenBytes;
    if (
      !Number.isSafeInteger(tokenBytes) ||
      !Number.isSafeInteger(addedBytes) ||
      additions.length + target.length > MAX_RUNTIME_TTS_ALIGNMENT_TOKENS ||
      currentBytes + addedBytes > MAX_RUNTIME_TTS_ALIGNMENT_TOKEN_BYTES
    ) {
      throw runtimeResourceLimitError(
        "TTS alignment tokens",
        "bytes",
        MAX_RUNTIME_TTS_ALIGNMENT_TOKEN_BYTES,
      );
    }
  }
  for (const start of startsToAdd) alignedCharacterStarts.add(start);
  for (const token of additions) target.push(token);
  return currentBytes + addedBytes;
}
