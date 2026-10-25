export const MAX_TTS_TEXT_CONTROLS = 32;
export const MAX_TTS_TEXT_CONTROL_MATCH_CODE_POINTS = 256;
export const MAX_TTS_TEXT_CONTROL_PAUSE_MS = 5_000;

export type TtsTextControlKind = "spell" | "pause";

export type TtsTextControl =
  | { readonly type: "spell"; readonly match: string }
  | { readonly type: "pause"; readonly match: string; readonly durationMs: number };

export function normalizeTtsTextControls(value: unknown): readonly TtsTextControl[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > MAX_TTS_TEXT_CONTROLS) {
    throw new TypeError(
      `TTS text controls must contain at most ${MAX_TTS_TEXT_CONTROLS} operations`,
    );
  }

  const controls = value.map((item): TtsTextControl => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new TypeError("TTS text control must be an object");
    }
    const control = item as Record<string, unknown>;
    if (
      typeof control.match !== "string" ||
      control.match.trim().length === 0 ||
      Array.from(control.match).length > MAX_TTS_TEXT_CONTROL_MATCH_CODE_POINTS ||
      /[\u0000-\u001f\u007f]/u.test(control.match)
    ) {
      throw new TypeError("TTS text control match must be a bounded, non-empty literal");
    }
    if (control.type === "spell") {
      return Object.freeze({ type: "spell", match: control.match });
    }
    if (control.type === "pause") {
      if (
        typeof control.durationMs !== "number" ||
        !Number.isSafeInteger(control.durationMs) ||
        control.durationMs < 1 ||
        control.durationMs > MAX_TTS_TEXT_CONTROL_PAUSE_MS
      ) {
        throw new TypeError(
          `TTS text control pause duration must be an integer from 1 through ${MAX_TTS_TEXT_CONTROL_PAUSE_MS} milliseconds`,
        );
      }
      return Object.freeze({
        type: "pause",
        match: control.match,
        durationMs: control.durationMs,
      });
    }
    throw new TypeError("TTS text control operation is unsupported");
  });

  for (let leftIndex = 0; leftIndex < controls.length; leftIndex += 1) {
    const left = controls[leftIndex]!.match;
    for (let rightIndex = leftIndex + 1; rightIndex < controls.length; rightIndex += 1) {
      const right = controls[rightIndex]!.match;
      if (left.includes(right) || right.includes(left)) {
        throw new TypeError("TTS text control match literals cannot overlap");
      }
    }
  }

  return Object.freeze(controls);
}
