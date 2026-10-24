import { describe, expect, it, vi } from "vitest";

import {
  createTtsTextPartBatches,
  createTtsTextParts,
  ttsTextPartsToPlainText,
  validateTtsTextOperations,
} from "../src/tts-text.js";

describe("createTtsTextParts", () => {
  it("returns no parts for empty text", () => {
    expect(createTtsTextParts("", [])).toEqual([]);
  });

  it("keeps markup-shaped input as literal text unless a typed operation targets it", () => {
    const text = 'Read <break time="1s"/> literally, then [pause].';

    expect(createTtsTextParts(text, [])).toEqual([{ type: "text", text }]);
  });

  it("applies host-authored spell and pause operations to exact text spans", () => {
    expect(
      createTtsTextParts("Your code is A7B9, please wait.", [
        { type: "spell", match: "A7B9" },
        { type: "pause_after", match: "A7B9", durationMs: 500 },
      ]),
    ).toEqual([
      { type: "text", text: "Your code is " },
      { type: "spell", text: "A7B9" },
      { type: "pause", durationMs: 500 },
      { type: "text", text: ", please wait." },
    ]);
  });

  it("applies typed IPA pronunciation without accepting provider markup", () => {
    expect(
      createTtsTextParts("Please ask for Sarvam.", [
        {
          type: "phoneme",
          match: "Sarvam",
          alphabet: "ipa",
          pronunciation: "sɑːrvəm",
        },
      ]),
    ).toEqual([
      { type: "text", text: "Please ask for " },
      { type: "phoneme", text: "Sarvam", alphabet: "ipa", pronunciation: "sɑːrvəm" },
      { type: "text", text: "." },
    ]);
  });

  it("rejects ambiguous overlapping matches and malformed operations", () => {
    expect(() =>
      createTtsTextParts("New York.", [
        { type: "spell", match: "New" },
        { type: "pause_after", match: "New York", durationMs: 200 },
      ]),
    ).toThrow(/overlap/u);
    expect(() =>
      createTtsTextParts("code", [{ type: "pause_after", match: "code", durationMs: 3_001 }]),
    ).toThrow(/durationMs/u);
  });

  it("rejects overlapping occurrences of the same configured match", () => {
    expect(() => createTtsTextParts("banana", [{ type: "spell", match: "ana" }])).toThrow(
      /must be unique/u,
    );
  });

  it("rejects oversized text without allocating an array of all code points", () => {
    const arrayFrom = vi.spyOn(Array, "from").mockImplementation(() => {
      throw new Error("oversized text was materialized as an array");
    });
    try {
      expect(() => createTtsTextParts("x".repeat(20_001), [])).toThrow(/20000 code points/u);
    } finally {
      arrayFrom.mockRestore();
    }
  });

  it("batches long text without splitting a typed operation across request limits", () => {
    const text = `${"x".repeat(19_998)}ABCD${"y".repeat(10)}`;
    const batches = [...createTtsTextPartBatches(text, [{ type: "spell", match: "ABCD" }])];

    expect(batches).toHaveLength(2);
    expect(batches.map(ttsTextPartsToPlainText).join("")).toBe(text);
    expect(batches.every((batch) => [...ttsTextPartsToPlainText(batch)].length <= 20_000)).toBe(
      true,
    );
    expect(batches.flat().filter((part) => part.type === "spell")).toEqual([
      { type: "spell", text: "ABCD" },
    ]);
  });

  it("keeps supplementary Unicode code points intact at batch boundaries", () => {
    const text = `${"x".repeat(19_999)}😀ABCD`;
    const batches = [...createTtsTextPartBatches(text, [{ type: "spell", match: "ABCD" }])];

    expect(batches.map(ttsTextPartsToPlainText)).toEqual([`${"x".repeat(19_999)}😀`, "ABCD"]);
  });

  it("validates every operation before yielding its first batch", () => {
    const batches = createTtsTextPartBatches(`${"x".repeat(20_000)}START`, [
      { type: "spell", match: "START" },
      { type: "spell", match: "MISSING" },
    ]);

    expect(() => batches.next()).toThrow(/match was not found/u);
  });

  it("rejects oversized operation targets without materializing their code points", () => {
    const arrayFrom = vi.spyOn(Array, "from").mockImplementation(() => {
      throw new Error("oversized operation target was materialized as an array");
    });
    try {
      expect(() => validateTtsTextOperations([{ type: "spell", match: "x".repeat(129) }])).toThrow(
        /128 control-free code points/u,
      );
    } finally {
      arrayFrom.mockRestore();
    }
  });

  it("rejects oversized phoneme pronunciations without materializing their code points", () => {
    const arrayFrom = vi.spyOn(Array, "from").mockImplementation(() => {
      throw new Error("oversized pronunciation was materialized as an array");
    });
    try {
      expect(() =>
        validateTtsTextOperations([
          {
            type: "phoneme",
            match: "word",
            alphabet: "ipa",
            pronunciation: "x".repeat(129),
          },
        ]),
      ).toThrow(/at most 128 code points/u);
    } finally {
      arrayFrom.mockRestore();
    }
  });
});

describe("ttsTextPartsToPlainText", () => {
  it("keeps speech text while excluding typed pronunciation and pause markup", () => {
    expect(
      ttsTextPartsToPlainText([
        { type: "text", text: "Code " },
        { type: "spell", text: "AB12" },
        { type: "pause", durationMs: 500 },
        { type: "text", text: "." },
        { type: "phoneme", text: "read", alphabet: "ipa", pronunciation: "ɹiːd" },
      ]),
    ).toBe("Code AB12.read");
  });

  it("rejects text parts over the count limit before mapping them", () => {
    const arrayMap = vi.spyOn(Array.prototype, "map").mockImplementation(() => {
      throw new Error("oversized text parts were materialized into an array");
    });
    try {
      const parts = Array.from({ length: 66 }, () => ({ type: "text" as const, text: "x" }));
      expect(() => ttsTextPartsToPlainText(parts)).toThrow(/at most 65 parts/u);
    } finally {
      arrayMap.mockRestore();
    }
  });

  it("rejects oversized plain text before joining a complete copy", () => {
    const arrayMap = vi.spyOn(Array.prototype, "map").mockImplementation(() => {
      throw new Error("oversized plain text was mapped before its bound");
    });
    try {
      expect(() => ttsTextPartsToPlainText([{ type: "text", text: "x".repeat(20_001) }])).toThrow(
        /20000 code points/u,
      );
    } finally {
      arrayMap.mockRestore();
    }
  });
});

describe("validateTtsTextOperations", () => {
  it("validates, copies, and freezes call-scoped operation input", () => {
    const input = [{ type: "spell", match: "AB12" }] as const;
    const validated = validateTtsTextOperations(input);

    expect(validated).toEqual(input);
    expect(validated).not.toBe(input);
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated[0])).toBe(true);
  });

  it("rejects malformed runtime operation values instead of dropping them", () => {
    expect(() => validateTtsTextOperations([{ type: "unknown", match: "word" } as never])).toThrow(
      "TTS text operation type is unsupported",
    );
  });
});
