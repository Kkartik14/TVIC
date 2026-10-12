import type { ProviderClock } from "./common.js";

export interface SarvamTtsHttpProviderOptions {
  readonly apiKey: string;
  readonly url?: string;
  readonly voiceId?: string;
  readonly modelId?: string;
  readonly language?: string;
  /** Provider pace. Sarvam Bulbul v3 and v4 Flash accept 0.5 through 2.0. */
  readonly pace?: number;
  /** HTTP temperature tuning for Sarvam Bulbul v3 and v4 Flash (0.01 through 1.0). */
  readonly temperature?: number;
  readonly pronunciationDictionaryId?: string;
  /** Maximum time allowed for request headers and the complete response. Defaults to 10 minutes. */
  readonly requestTimeoutMs?: number;
  /** Maximum wait for response progress after headers arrive. Defaults to 30 seconds. */
  readonly responseIdleTimeoutMs?: number;
  readonly clock?: ProviderClock;
  /** Injectable fetch makes protocol and failure tests hermetic. */
  readonly fetchImpl?: typeof fetch;
}
