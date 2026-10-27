import {
  PROVIDER_CAPABILITY_FEATURES,
  PROVIDER_NAMES,
  createProviderCapabilitySnapshot,
} from "@tvic/core";
import { ELEVENLABS_CAPABILITY_FEATURES } from "../src/index.js";

export function elevenLabsCapabilitySnapshot(options: {
  readonly model: string;
  readonly additionalModels?: readonly string[];
  readonly voice: string;
  readonly additionalVoices?: readonly string[];
  readonly language?: string;
  readonly speakerBoost?: boolean;
  readonly speakerBoostSupported?: boolean;
  readonly forcedNormalization?: boolean;
}) {
  const models = [...new Set([options.model, ...(options.additionalModels ?? [])])];
  const voices = [...new Set([options.voice, ...(options.additionalVoices ?? [])])];
  const facts = [
    ...models.flatMap((model) => [
      {
        feature: PROVIDER_CAPABILITY_FEATURES.ttsModelAvailable,
        scope: "model" as const,
        model,
        status: "supported" as const,
      },
      ...(model.startsWith("eleven_v3")
        ? []
        : [
            {
              feature: PROVIDER_CAPABILITY_FEATURES.ttsModelCanDoTextToSpeech,
              scope: "model" as const,
              model,
              status: "supported" as const,
              value: true,
            },
          ]),
      ...(options.speakerBoost
        ? [
            {
              feature: ELEVENLABS_CAPABILITY_FEATURES.ttsModelCanUseSpeakerBoost,
              scope: "model" as const,
              model,
              status: "supported" as const,
              value: options.speakerBoostSupported ?? true,
            },
          ]
        : []),
    ]),
    ...voices.flatMap((voice) => [
      {
        feature: ELEVENLABS_CAPABILITY_FEATURES.ttsVoiceCategory,
        scope: "voice" as const,
        voice,
        status: "supported" as const,
        value: "premade",
      },
      ...models.map((model) => ({
        feature: PROVIDER_CAPABILITY_FEATURES.ttsVoiceAvailable,
        scope: "voice" as const,
        model,
        voice,
        status: "supported" as const,
      })),
      ...(options.language === undefined
        ? []
        : models.map((model) => ({
            feature: ELEVENLABS_CAPABILITY_FEATURES.ttsVoiceVerifiedLocales,
            scope: "voice" as const,
            model,
            voice,
            status: "supported" as const,
            value: [options.language],
          }))),
    ]),
    ...(options.forcedNormalization
      ? [
          {
            feature: ELEVENLABS_CAPABILITY_FEATURES.ttsForcedNormalization,
            scope: "account" as const,
            status: "supported" as const,
          },
        ]
      : []),
  ];
  const now = Date.now();
  return createProviderCapabilitySnapshot({
    provider: PROVIDER_NAMES.elevenlabs,
    source: "https://provider.example/capabilities",
    fetchedAt: new Date(now - 1_000).toISOString(),
    validUntil: new Date(now + 60_000).toISOString(),
    facts,
  });
}
