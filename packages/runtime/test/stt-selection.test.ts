import { describe, expect, it } from "vitest";

import type { SpeechToTextProvider } from "@tvic/core";
import { resolveSttCallSelection } from "../src/stt-selection.js";

const provider: SpeechToTextProvider = {
  name: "selection-stt",
  kind: "stt",
  version: "1.0.0",
  capabilities: {
    streaming: { input: true, output: true, native: true },
    cancellation: { request: true, output: false, buffer: false, truncation: false },
    transports: ["websocket"],
  },
  supportsSttLanguagePolicy: (policy, model) =>
    model === "stt-model" &&
    (policy.mode === "auto" ||
      (policy.mode === "fixed" && policy.language === "hi-IN") ||
      (policy.mode === "hints" && policy.languages.length > 0 && !policy.strictness)),
  supportsSttVocabulary: (vocabulary, model) => model === "stt-model" && vocabulary.length > 0,
  supportsSttAgentContext: (model) => model === "stt-model",
  async open() {
    throw new Error("not used");
  },
};

describe("resolveSttCallSelection", () => {
  it("preserves the legacy STT language value without policy validation", () => {
    expect(
      resolveSttCallSelection(provider, {
        model: "stt-model",
        sttLanguage: "hi_IN",
      }),
    ).toEqual({
      language: "hi_IN",
      agentContextUpdates: false,
    });
  });

  it("passes legacy language values to host-written providers without policy callbacks", () => {
    const hostWrittenProvider = { ...provider } as SpeechToTextProvider;
    Object.defineProperty(hostWrittenProvider, "supportsSttLanguagePolicy", { value: undefined });

    expect(resolveSttCallSelection(hostWrittenProvider, { sttLanguage: "multi" })).toMatchObject({
      language: "multi",
    });
    expect(resolveSttCallSelection(hostWrittenProvider, { sttLanguage: "" })).toMatchObject({
      language: "",
    });
  });

  it("canonicalizes and deduplicates language hints before provider preflight", () => {
    expect(
      resolveSttCallSelection(provider, {
        model: "stt-model",
        sttLanguagePolicy: { mode: "hints", languages: ["en-in", "hi-IN", "EN-IN"] },
      }),
    ).toEqual({
      languagePolicy: { mode: "hints", languages: ["en-IN", "hi-IN"] },
      agentContextUpdates: false,
    });
  });

  it("trims and exact-deduplicates vocabulary while preserving first-seen case", () => {
    expect(
      resolveSttCallSelection(provider, {
        model: "stt-model",
        vocabulary: [" Acme ", "acme", "Acme"],
      }),
    ).toEqual({ vocabulary: ["Acme", "acme"], agentContextUpdates: false });
  });

  it("rejects context updates without an explicit provider capability", () => {
    const undeclared = { ...provider } as SpeechToTextProvider;
    Object.defineProperty(undeclared, "supportsSttAgentContext", { value: undefined });

    expect(() => resolveSttCallSelection(undeclared, { sttConversationContext: true })).toThrow(
      /does not declare STT agent context support/u,
    );
  });

  it("enables declared context updates in the immutable call selection", () => {
    const selection = resolveSttCallSelection(provider, {
      model: "stt-model",
      sttConversationContext: true,
    });

    expect(selection.agentContextUpdates).toBe(true);
    expect(Object.isFrozen(selection)).toBe(true);
  });

  it("rejects unsupported explicit controls when the provider lacks their declaration", () => {
    const undeclared = { ...provider } as SpeechToTextProvider;
    Object.defineProperty(undeclared, "supportsSttLanguagePolicy", { value: undefined });
    Object.defineProperty(undeclared, "supportsSttVocabulary", { value: undefined });

    expect(() =>
      resolveSttCallSelection(undeclared, {
        sttLanguagePolicy: { mode: "auto" },
      }),
    ).toThrow(/does not declare STT language-policy support/u);
    expect(() => resolveSttCallSelection(undeclared, { vocabulary: ["Acme"] })).toThrow(
      /does not declare STT vocabulary support/u,
    );
  });

  it("rejects ambiguous and malformed explicit language policies", () => {
    expect(() =>
      resolveSttCallSelection(provider, {
        sttLanguage: "hi-IN",
        sttLanguagePolicy: { mode: "auto" },
      }),
    ).toThrow(/cannot be combined/u);
    expect(() =>
      resolveSttCallSelection(provider, {
        sttLanguagePolicy: { mode: "hints", languages: [] },
      }),
    ).toThrow(/at least one language hint/u);
  });
});
