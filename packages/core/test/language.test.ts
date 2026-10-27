import { describe, expect, it } from "vitest";

import {
  canonicalizeLanguageTag,
  normalizeLanguageStringMap,
  normalizeStrictLanguageTag,
  primaryLanguageSubtag,
} from "../src/index.js";

describe("canonicalizeLanguageTag", () => {
  it("returns the canonical casing and aliases for valid tags", () => {
    expect(canonicalizeLanguageTag("en-us")).toBe("en-US");
    expect(canonicalizeLanguageTag("iw-IL")).toBe("he-IL");
  });

  it("returns undefined for invalid tags without trimming them", () => {
    expect(canonicalizeLanguageTag("hi_IN")).toBeUndefined();
    expect(canonicalizeLanguageTag(" en-US ")).toBeUndefined();
    expect(canonicalizeLanguageTag("")).toBeUndefined();
    expect(canonicalizeLanguageTag("i-klingon")).toBeUndefined();
  });

  it("does not decide whether syntactically valid application mode values are allowed", () => {
    expect(canonicalizeLanguageTag("multi")).toBe("multi");
    expect(canonicalizeLanguageTag("unknown")).toBe("unknown");
  });

  it("returns undefined for non-string input", () => {
    expect(canonicalizeLanguageTag(null)).toBeUndefined();
    expect(canonicalizeLanguageTag(42)).toBeUndefined();
  });
});

describe("primaryLanguageSubtag", () => {
  it("returns the primary language from a valid language tag", () => {
    expect(primaryLanguageSubtag("en-US")).toBe("en");
    expect(primaryLanguageSubtag("zh-Hant-TW")).toBe("zh");
  });
});

describe("normalizeStrictLanguageTag", () => {
  it("trims and canonicalizes strict tags while rejecting STT mode words", () => {
    expect(normalizeStrictLanguageTag(" en-us ")).toEqual({ ok: true, value: "en-US" });
    expect(normalizeStrictLanguageTag("multi")).toEqual({ ok: false, reason: "mode_value" });
    expect(normalizeStrictLanguageTag("unknown")).toEqual({ ok: false, reason: "mode_value" });
    expect(normalizeStrictLanguageTag("hi_IN")).toEqual({ ok: false, reason: "invalid_tag" });
    expect(normalizeStrictLanguageTag("  ")).toEqual({ ok: false, reason: "empty" });
  });
});

describe("normalizeLanguageStringMap", () => {
  it("canonicalizes keys, keeps the original values, and freezes the result", () => {
    const result = normalizeLanguageStringMap({ "en-us": "  voice-a  " }, 2);
    expect(result).toEqual({ ok: true, value: { "en-US": "  voice-a  " } });
    if (result.ok) expect(Object.isFrozen(result.value)).toBe(true);
  });

  it.each([
    [null, 1, "invalid_object"],
    [[], 1, "invalid_object"],
    [{ en: "one", fr: "two" }, 1, "too_many_entries"],
    [{ "en-us": "one", "en-US": "two" }, 2, "duplicate_language"],
    [{ en_US: "one" }, 1, "invalid_language"],
    [{ en: "  " }, 1, "invalid_value"],
    [{ en: 42 }, 1, "invalid_value"],
  ])("reports %s as %s", (input, maxEntries, reason) => {
    const result = normalizeLanguageStringMap(input, maxEntries);
    expect(result).toMatchObject({ ok: false, reason });
  });

  it("requires a valid entry limit", () => {
    expect(() => normalizeLanguageStringMap({}, -1)).toThrow(RangeError);
    expect(() => normalizeLanguageStringMap({}, Number.NaN)).toThrow(RangeError);
  });
});
