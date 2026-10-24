import { describe, expect, it } from "vitest";

import type { TextToSpeechProvider } from "@tvic/core";
import { resolveTtsCallSelection } from "../src/tts-selection.js";

const provider = {
  name: "selection-tts",
  kind: "tts",
  version: "1.0.0",
  capabilities: {
    streaming: { input: true, output: true, native: true },
    cancellation: { request: true, output: true, buffer: true, truncation: true },
    transports: ["websocket"],
    models: ["model-default", "model-call"],
    voices: ["voice-default", "voice-call"],
  },
  configuredModel: "model-default",
  configuredVoice: "voice-default",
  supportsTtsLanguage: (language: string, model?: string, voice?: string) =>
    language === "hi-IN" && model === "model-call" && voice === "voice-call",
  supportsTtsSpeed: (speed: number, model?: string, voice?: string) =>
    speed === 1.1 && model === "model-call" && voice === "voice-call",
  synthesize: async () => {
    throw new Error("not used");
  },
} as unknown as TextToSpeechProvider;

describe("resolveTtsCallSelection", () => {
  it("uses request overrides and validates them against the selected model and voice", () => {
    expect(
      resolveTtsCallSelection(provider, {
        model: "model-call",
        voice: "voice-call",
        language: "hi-IN",
        speed: 1.1,
      }),
    ).toEqual({
      model: "model-call",
      modelSource: "request",
      voice: "voice-call",
      language: "hi-IN",
      speed: 1.1,
    });
  });

  it("keeps configured model and voice when no override is requested", () => {
    expect(resolveTtsCallSelection(provider, {})).toEqual({
      model: "model-default",
      modelSource: "configured",
      voice: "voice-default",
    });
  });

  it("rejects unknown models and voices before a call starts", () => {
    expect(() => resolveTtsCallSelection(provider, { model: "unknown" })).toThrow(
      /does not support model unknown/u,
    );
    expect(() => resolveTtsCallSelection(provider, { voice: "unknown" })).toThrow(
      /does not support voice unknown/u,
    );
  });

  it("rejects explicit language and speed when the adapter has no declarations", () => {
    const undeclared = { ...provider } as unknown as TextToSpeechProvider;
    Object.defineProperty(undeclared, "supportsTtsLanguage", { value: undefined });
    Object.defineProperty(undeclared, "supportsTtsSpeed", { value: undefined });

    expect(() => resolveTtsCallSelection(undeclared, { language: "hi-IN" })).toThrow(
      /does not declare support for request-level TTS language/u,
    );
    expect(() => resolveTtsCallSelection(undeclared, { speed: 1.1 })).toThrow(
      /does not declare support for request-level TTS speed/u,
    );
  });

  it("rejects an unsupported language or speed for the chosen model and voice", () => {
    expect(() =>
      resolveTtsCallSelection(provider, { model: "model-default", language: "hi-IN" }),
    ).toThrow(/does not support TTS language hi-IN/u);
    expect(() =>
      resolveTtsCallSelection(provider, { model: "model-default", speed: 1.1 }),
    ).toThrow(/does not support TTS speed 1.1/u);
  });
});
