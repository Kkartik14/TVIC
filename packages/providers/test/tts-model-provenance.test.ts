import { describe, expect, it } from "vitest";

import { CartesiaTtsProvider } from "../src/cartesia.js";
import { ElevenLabsTtsProvider } from "../src/elevenlabs.js";
import {
  ElevenLabsTtsHttpStreamProvider,
  ElevenLabsTtsRestProvider,
} from "../src/elevenlabs-http.js";
import { SarvamTtsProvider } from "../src/sarvam-tts.js";
import { SarvamTtsHttpStreamProvider, SarvamTtsRestProvider } from "../src/sarvam-tts-http.js";
import { PROVIDER_CATALOG } from "../src/catalog.js";

const adapters = [
  [
    "Cartesia websocket",
    PROVIDER_CATALOG.cartesia.defaultModel,
    (modelId?: string) =>
      new CartesiaTtsProvider({
        apiKey: "test",
        voiceId: "voice",
        ...(modelId !== undefined ? { modelId } : {}),
      }),
  ],
  [
    "ElevenLabs websocket",
    PROVIDER_CATALOG.elevenlabs.defaultModel,
    (modelId?: string) =>
      new ElevenLabsTtsProvider({
        apiKey: "test",
        voiceId: "voice",
        ...(modelId !== undefined ? { modelId } : {}),
      }),
  ],
  [
    "ElevenLabs REST",
    PROVIDER_CATALOG.elevenlabs.defaultModel,
    (modelId?: string) =>
      new ElevenLabsTtsRestProvider({
        apiKey: "test",
        voiceId: "voice",
        ...(modelId !== undefined ? { modelId } : {}),
      }),
  ],
  [
    "ElevenLabs HTTP stream",
    PROVIDER_CATALOG.elevenlabs.defaultModel,
    (modelId?: string) =>
      new ElevenLabsTtsHttpStreamProvider({
        apiKey: "test",
        voiceId: "voice",
        ...(modelId !== undefined ? { modelId } : {}),
      }),
  ],
  [
    "Sarvam websocket",
    PROVIDER_CATALOG.sarvamTts.defaultModel,
    (modelId?: string) =>
      new SarvamTtsProvider({ apiKey: "test", ...(modelId !== undefined ? { modelId } : {}) }),
  ],
  [
    "Sarvam REST",
    PROVIDER_CATALOG.sarvamTts.defaultModel,
    (modelId?: string) =>
      new SarvamTtsRestProvider({ apiKey: "test", ...(modelId !== undefined ? { modelId } : {}) }),
  ],
  [
    "Sarvam HTTP stream",
    PROVIDER_CATALOG.sarvamTts.defaultModel,
    (modelId?: string) =>
      new SarvamTtsHttpStreamProvider({
        apiKey: "test",
        ...(modelId !== undefined ? { modelId } : {}),
      }),
  ],
] as const;

describe("TTS configured model provenance", () => {
  it.each(adapters)(
    "distinguishes an implicit model from an explicit one: %s",
    (_name, defaultModel, create) => {
      const implicit = create();
      const explicit = create(defaultModel);

      expect((implicit as unknown as Record<string, unknown>).configuredModelSource).toBe(
        "not_reported",
      );
      expect((explicit as unknown as Record<string, unknown>).configuredModelSource).toBe(
        "configured",
      );
    },
  );
});
