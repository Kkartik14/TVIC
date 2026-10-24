import { describe, expect, it } from "vitest";

import { createTtsTextParts } from "../src/tts-text.js";

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
});
