import type { TtsAlignmentUnit } from "@tvic/core";

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
): void {
  if (unit === "character") {
    incoming.forEach((token, index) => {
      const start = startMs[index];
      if (start !== undefined && alignedCharacterStarts.has(start)) return;
      if (start !== undefined) alignedCharacterStarts.add(start);
      target.push(token);
    });
    return;
  }

  let overlap = Math.min(target.length, incoming.length);
  while (
    overlap > 0 &&
    !incoming
      .slice(0, overlap)
      .every((token, index) => target[target.length - overlap + index] === token)
  ) {
    overlap -= 1;
  }
  target.push(...incoming.slice(overlap));
}
