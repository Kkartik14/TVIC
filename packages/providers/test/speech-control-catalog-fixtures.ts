import { createSpeechControlCatalogSnapshot } from "@tvic/core";
import type { SpeechControlCatalogSnapshot } from "@tvic/core";

import { PROVIDER_CATALOG } from "../src/catalog.js";

const CATALOG_TIMING = {
  fetchedAt: "2026-10-24T00:00:00.000Z",
  validUntil: "2099-01-01T00:00:00.000Z",
};

const CARTESIA_VOICE_SOURCE = "https://docs.cartesia.ai/api-reference/voices/get";
const ELEVENLABS_VOICE_SOURCE = "https://elevenlabs.io/docs/api-reference/voices/search";

export function cartesiaVoiceCatalog(
  voice: string,
  options: { readonly professionalClone?: boolean; readonly extraModels?: readonly string[] } = {},
): SpeechControlCatalogSnapshot {
  const models = [
    ...new Set([...PROVIDER_CATALOG.cartesia.models, ...(options.extraModels ?? [])]),
  ];
  return createSpeechControlCatalogSnapshot(
    models.flatMap((model) => [
      {
        provider: "cartesia",
        control: "tts.voice",
        scope: { type: "account" as const, model, voice },
        status: "supported" as const,
        mutability: "provider" as const,
        source: CARTESIA_VOICE_SOURCE,
        verifiedAt: "2026-10-25",
      },
      {
        provider: "cartesia",
        control: "tts.language",
        scope: { type: "account" as const, model, voice },
        status: "supported" as const,
        mutability: "call" as const,
        source: CARTESIA_VOICE_SOURCE,
        verifiedAt: "2026-10-25",
        languages: ["en-US", "hi-IN", "fil-PH"],
      },
      {
        provider: "cartesia",
        control: "tts.speed",
        scope: { type: "account" as const, model, voice },
        status: options.professionalClone ? ("unsupported" as const) : ("supported" as const),
        mutability: "call" as const,
        source: CARTESIA_VOICE_SOURCE,
        verifiedAt: "2026-10-25",
        ...(!options.professionalClone ? { limits: { min: 0.6, max: 1.5 } } : {}),
      },
    ]),
    CATALOG_TIMING,
  );
}

export function elevenLabsVoiceCatalog(
  voices: readonly string[],
  options: { readonly extraModels?: readonly string[] } = {},
): SpeechControlCatalogSnapshot {
  const models = [
    ...new Set([...PROVIDER_CATALOG.elevenlabs.models, ...(options.extraModels ?? [])]),
  ];
  return createSpeechControlCatalogSnapshot(
    models.flatMap((model) =>
      voices.map((voice) => ({
        provider: "elevenlabs",
        control: "tts.voice",
        scope: { type: "account" as const, model, voice },
        status: "supported" as const,
        mutability: "provider" as const,
        source: ELEVENLABS_VOICE_SOURCE,
        verifiedAt: "2026-10-25",
      })),
    ),
    CATALOG_TIMING,
  );
}
