import { describe, expect, it } from "vitest";

import {
  validateTtsPronunciationDictionaries,
  validateTtsTextNormalization,
} from "../src/tts-controls.js";

describe("validateTtsTextNormalization", () => {
  it("copies and freezes a locale normalization setting", () => {
    const setting = { mode: "locale", locale: "en-in" } as const;
    const result = validateTtsTextNormalization(setting);

    expect(result).toEqual({ mode: "locale", locale: "en-IN" });
    expect(result).not.toBe(setting);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("rejects unsupported modes and malformed locales", () => {
    expect(() => validateTtsTextNormalization("provider-default" as never)).toThrow(
      /normalization/u,
    );
    expect(() =>
      validateTtsTextNormalization({ mode: "locale", locale: "not a locale" } as never),
    ).toThrow(/BCP-47/u);
  });
});

describe("validateTtsPronunciationDictionaries", () => {
  it("copies and freezes bounded provider-managed dictionary references", () => {
    const input = [{ id: "tenant-dictionary", version: "v2" }] as const;
    const result = validateTtsPronunciationDictionaries(input);

    expect(result).toEqual(input);
    expect(result).not.toBe(input);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result[0])).toBe(true);
  });

  it("rejects duplicate IDs, invalid identifiers, and more than three references", () => {
    expect(() =>
      validateTtsPronunciationDictionaries([{ id: "same" }, { id: "same", version: "v2" }]),
    ).toThrow(/duplicate/u);
    expect(() => validateTtsPronunciationDictionaries([{ id: "bad\nvalue" }])).toThrow(
      /identifier/u,
    );
    expect(() =>
      validateTtsPronunciationDictionaries([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }]),
    ).toThrow(/at most 3/u);
  });
});
