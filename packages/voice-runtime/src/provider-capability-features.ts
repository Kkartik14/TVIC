import { PROVIDER_CAPABILITY_FEATURES as CORE_CAPABILITY_FEATURES } from "@tvic/core";
import { CARTESIA_CAPABILITY_FEATURES, ELEVENLABS_CAPABILITY_FEATURES } from "@tvic/providers";

/**
 * @deprecated Use the provider-specific feature constants. This compatibility
 * export stays on the voice-runtime package surface; provider-specific feature
 * names no longer live in the provider-neutral core package.
 */
export const PROVIDER_CAPABILITY_FEATURES = Object.freeze({
  ...CORE_CAPABILITY_FEATURES,
  ttsVoiceIsPro: CARTESIA_CAPABILITY_FEATURES.ttsVoiceIsPro,
  ttsVoiceAccentLocales: CARTESIA_CAPABILITY_FEATURES.ttsVoiceAccentLocales,
  ttsVoiceVerifiedLocales: ELEVENLABS_CAPABILITY_FEATURES.ttsVoiceVerifiedLocales,
  ttsModelCanUseStyle: ELEVENLABS_CAPABILITY_FEATURES.ttsModelCanUseStyle,
  ttsModelCanUseSpeakerBoost: ELEVENLABS_CAPABILITY_FEATURES.ttsModelCanUseSpeakerBoost,
  ttsModelServesProfessionalVoices: ELEVENLABS_CAPABILITY_FEATURES.ttsModelServesProfessionalVoices,
  ttsForcedNormalization: ELEVENLABS_CAPABILITY_FEATURES.ttsForcedNormalization,
} as const);
