import { describe, expect, it, vi } from "vitest";

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

  it("rejects partially overlapping match literals", () => {
    expect(() =>
      normalizeTtsTextControls([
        { type: "spell", match: "AB" },
        { type: "pause", match: "BC", durationMs: 100 },
      ]),
    ).toThrow(/overlap/);
  });

  it.each(["\ud800", "\udc00"])(
    "rejects an unpaired surrogate in a match literal",
    (match) => {
      expect(() => normalizeTtsTextControls([{ type: "spell", match }])).toThrow(
        /well-formed Unicode/,
      );
    },
  );

  it("keeps valid supplementary code points in a match literal", () => {
    expect(normalizeTtsTextControls([{ type: "spell", match: "😀" }])).toEqual([
      { type: "spell", match: "😀" },
    ]);
  });

  it("bounds oversized match validation without materializing every code point", () => {
    const arrayFrom = vi.spyOn(Array, "from");
    try {
      expect(() =>
        normalizeTtsTextControls([{ type: "spell", match: "x".repeat(100_000) }]),
      ).toThrow(/bounded/);
      expect(arrayFrom).not.toHaveBeenCalled();
    } finally {
      arrayFrom.mockRestore();
    }
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
