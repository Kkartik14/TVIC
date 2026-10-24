import { describe, expect, it } from "vitest";

import type { TextToSpeechProvider } from "@tvic/core";
import { resolveTtsCallSelection } from "../src/tts-selection.js";
import type { TtsCallSelectionInput } from "../src/tts-selection.js";

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
    expect(() => resolveTtsCallSelection(provider, { model: "model-default", speed: 1.1 })).toThrow(
      /does not support TTS speed 1.1/u,
    );
  });

  it("rejects a selected call when the provider preflight rejects the combined settings", () => {
    const preflightProvider = {
      ...provider,
      supportsTtsSelection: (selection: {
        readonly model?: string;
        readonly voice?: string;
        readonly language?: string;
        readonly speed?: number;
      }) =>
        !(
          selection.model === "model-call" &&
          selection.voice === "voice-call" &&
          selection.language === "hi-IN" &&
          selection.speed === 1.1
        ),
    } as unknown as TextToSpeechProvider;

    expect(() =>
      resolveTtsCallSelection(preflightProvider, {
        model: "model-call",
        voice: "voice-call",
        language: "hi-IN",
        speed: 1.1,
      }),
    ).toThrow(/does not support the selected TTS settings/u);
  });

  it("requires and validates a language for providers that require one on the selected model", () => {
    const sarvamV4 = {
      ...provider,
      configuredModel: "bulbul:v4-flash",
      configuredVoice: "simran_en_customer",
      configuredLanguage: "en-IN",
      languageWasExplicitlyConfigured: false,
      capabilities: {
        ...provider.capabilities,
        models: ["bulbul:v4-flash"],
        voices: ["simran_en_customer"],
      },
      requiresTtsLanguageForModel: (model?: string) => model === "bulbul:v4-flash",
      supportsTtsLanguage: (language: string, model?: string, voice?: string) =>
        language === "en-IN" && model === "bulbul:v4-flash" && voice === "simran_en_customer",
    } as unknown as TextToSpeechProvider;

    expect(() => resolveTtsCallSelection(sarvamV4, {})).toThrow(/requires a TTS language/u);
    expect(resolveTtsCallSelection(sarvamV4, { language: "en-IN" })).toMatchObject({
      model: "bulbul:v4-flash",
      voice: "simran_en_customer",
      language: "en-IN",
    });
    expect(() => resolveTtsCallSelection(sarvamV4, { language: "hi-IN" })).toThrow(
      /does not support TTS language hi-IN/u,
    );
  });

  it("uses an explicitly configured provider language for models that require one", () => {
    const sarvamV4 = {
      ...provider,
      configuredModel: "bulbul:v4-flash",
      configuredVoice: "simran_en_customer",
      configuredLanguage: "en-IN",
      languageWasExplicitlyConfigured: true,
      capabilities: {
        ...provider.capabilities,
        models: ["bulbul:v4-flash"],
        voices: ["simran_en_customer"],
      },
      requiresTtsLanguageForModel: (model?: string) => model === "bulbul:v4-flash",
      supportsTtsLanguage: (language: string, model?: string, voice?: string) =>
        language === "en-IN" && model === "bulbul:v4-flash" && voice === "simran_en_customer",
    } as unknown as TextToSpeechProvider;

    expect(resolveTtsCallSelection(sarvamV4, {})).toMatchObject({
      language: "en-IN",
    });
  });

  it("selects a fixed call voice from the output language map without changing the model", () => {
    const overrides = {
      model: "model-call",
      language: "hi-in",
      voicesByLanguage: { "hi-IN": "voice-call" },
    };

    expect(resolveTtsCallSelection(provider, overrides)).toEqual({
      model: "model-call",
      modelSource: "request",
      voice: "voice-call",
      language: "hi-IN",
    });
  });

  it("uses the run-level voice map in place of the configured map", () => {
    const overrides: TtsCallSelectionInput = {
      model: "model-call",
      language: "hi-IN",
      voicesByLanguage: { "hi-IN": "voice-call" },
    };

    expect(
      resolveTtsCallSelection(provider, overrides, {
        voicesByLanguage: { "hi-IN": "voice-default" },
      }),
    ).toMatchObject({ model: "model-call", voice: "voice-call", language: "hi-IN" });
  });

  it("validates every voice-language map entry before selecting the call voice", () => {
    const mapProvider = {
      ...provider,
      supportsTtsLanguage: (language: string, model?: string, voice?: string) =>
        language === "hi-IN" && model === "model-default" && voice === "voice-call",
    } as unknown as TextToSpeechProvider;
    const overrides: TtsCallSelectionInput = {
      language: "hi-IN",
      voicesByLanguage: { "hi-IN": "voice-call", "en-US": "voice-default" },
    };

    expect(() => resolveTtsCallSelection(mapProvider, overrides)).toThrow(
      /does not support TTS language en-US for model model-default and voice voice-default/u,
    );
  });
});
