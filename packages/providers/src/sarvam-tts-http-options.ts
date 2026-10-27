import type { ProviderClock } from "./common.js";
import type { SarvamTtsVoiceLanguages } from "./sarvam-tts-model.js";

export interface SarvamTtsHttpProviderOptions {
  readonly apiKey: string;
  readonly url?: string;
  readonly voiceId?: string;
  readonly modelId?: string;
  readonly language?: string;
  /** Optional host-supplied Bulbul v4 persona-to-language allowlist (up to 128 voices). */
  readonly voiceLanguages?: SarvamTtsVoiceLanguages;
  readonly pace?: number;
  readonly temperature?: number;
  readonly pronunciationDictionaryId?: string;
  readonly requestTimeoutMs?: number;
  readonly responseIdleTimeoutMs?: number;
  readonly clock?: ProviderClock;
  readonly fetchImpl?: typeof fetch;
}
