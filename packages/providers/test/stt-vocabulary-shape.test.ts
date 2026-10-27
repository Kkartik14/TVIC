import { describe, expect, it } from "vitest";

import type { SpeechToTextProvider, SttOpenRequest } from "@tvic/core";
import { PCM16_16K_MONO, PROVIDER_NAMES, STT_ERROR_CODES } from "@tvic/core";

import {
  AssemblyAiSttProvider,
  CartesiaSttProvider,
  DeepgramSttProvider,
  ElevenLabsSttProvider,
  SarvamSttProvider,
  SonioxSttProvider,
} from "../src/index.js";

interface AdapterCase {
  readonly name: string;
  readonly providerName: string;
  readonly model?: string;
  readonly invalidRequestCode: string;
  readonly create: (incrementSocketCalls: () => void) => SpeechToTextProvider;
}

const adapters: readonly AdapterCase[] = [
  {
    name: "Cartesia",
    providerName: PROVIDER_NAMES.cartesiaStt,
    invalidRequestCode: STT_ERROR_CODES.vocabularyInvalid,
    create: (increment) =>
      new CartesiaSttProvider({
        apiKey: "test",
        modelId: "ink-2",
        webSocketFactory: () => {
          increment();
          throw new Error("invalid vocabulary must be rejected before opening a socket");
        },
      }),
  },
  {
    name: "AssemblyAI",
    providerName: PROVIDER_NAMES.assemblyaiStt,
    invalidRequestCode: STT_ERROR_CODES.vocabularyInvalid,
    create: (increment) =>
      new AssemblyAiSttProvider({
        apiKey: "test",
        webSocketFactory: () => {
          increment();
          throw new Error("invalid vocabulary must be rejected before opening a socket");
        },
      }),
  },
  {
    name: "Soniox",
    providerName: PROVIDER_NAMES.sonioxStt,
    invalidRequestCode: STT_ERROR_CODES.vocabularyInvalid,
    create: (increment) =>
      new SonioxSttProvider({
        apiKey: "test",
        webSocketFactory: () => {
          increment();
          throw new Error("invalid vocabulary must be rejected before opening a socket");
        },
      }),
  },
  {
    name: "Deepgram",
    providerName: PROVIDER_NAMES.deepgram,
    invalidRequestCode: STT_ERROR_CODES.vocabularyInvalid,
    create: (increment) =>
      new DeepgramSttProvider({
        apiKey: "test",
        webSocketFactory: () => {
          increment();
          throw new Error("invalid vocabulary must be rejected before opening a socket");
        },
      }),
  },
  {
    name: "ElevenLabs",
    providerName: PROVIDER_NAMES.elevenlabsStt,
    invalidRequestCode: STT_ERROR_CODES.vocabularyInvalid,
    create: (increment) =>
      new ElevenLabsSttProvider({
        apiKey: "test",
        webSocketFactory: () => {
          increment();
          throw new Error("invalid vocabulary must be rejected before opening a socket");
        },
      }),
  },
  {
    name: "Sarvam",
    providerName: PROVIDER_NAMES.sarvam,
    model: "saaras:v4",
    invalidRequestCode: STT_ERROR_CODES.vocabularyInvalid,
    create: (increment) =>
      new SarvamSttProvider({
        apiKey: "test",
        webSocketFactory: () => {
          increment();
          throw new Error("invalid vocabulary must be rejected before opening a socket");
        },
      }),
  },
];

const malformedVocabularyValues: readonly unknown[] = [null, {}, ["valid", 7]];

describe("STT vocabulary shape validation", () => {
  it.each(adapters)("$name safely rejects malformed vocabulary", async (adapter) => {
    let socketCalls = 0;
    const provider = adapter.create(() => {
      socketCalls += 1;
    });

    for (const vocabulary of malformedVocabularyValues) {
      expect(provider.supportsSttVocabulary?.(vocabulary as never)).toBe(false);
      await expect(
        provider.open({
          sessionId: "malformed-vocabulary" as SttOpenRequest["sessionId"],
          format: PCM16_16K_MONO,
          interimResults: true,
          ...(adapter.model !== undefined ? { model: adapter.model } : {}),
          vocabulary: vocabulary as readonly string[],
        }),
      ).rejects.toMatchObject({
        code: adapter.invalidRequestCode,
        provider: adapter.providerName,
      });
    }

    expect(socketCalls).toBe(0);
  });
});
