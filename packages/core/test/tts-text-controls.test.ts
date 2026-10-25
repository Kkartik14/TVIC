import { describe, expect, it } from "vitest";

import { normalizeTtsTextControls } from "../src/index.js";

describe("TTS text controls", () => {
  it("normalizes bounded spell and pause controls without changing their literals", () => {
    const controls = normalizeTtsTextControls([
      { type: "spell", match: "A&B <ID>" },
      { type: "pause", match: "thank you", durationMs: 750 },
    ]);

    expect(controls).toEqual([
      { type: "spell", match: "A&B <ID>" },
      { type: "pause", match: "thank you", durationMs: 750 },
    ]);
    expect(Object.isFrozen(controls)).toBe(true);
    expect(Object.isFrozen(controls[0])).toBe(true);
  });

  it("rejects overlapping match literals that would make markup ambiguous", () => {
    expect(() =>
      normalizeTtsTextControls([
        { type: "spell", match: "account number" },
        { type: "pause", match: "number", durationMs: 100 },
      ]),
    ).toThrow(/overlap/);
  });

  it.each([
    [{ type: "spell", match: " " }],
    [{ type: "pause", match: "ID", durationMs: 0 }],
    [{ type: "pause", match: "ID", durationMs: 5_001 }],
    [{ type: "phoneme", match: "TVIC", phonemes: "t-vik" }],
  ])("rejects malformed or unsupported operations", (controls) => {
    expect(() => normalizeTtsTextControls(controls as never)).toThrow(/TTS text control/);
  });
});
