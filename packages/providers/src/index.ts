import type {
  AudioFormat,
  LLMProvider,
  Provider,
  ProviderKind,
  RealtimeModelProvider,
  SpeechToTextProvider,
  TelephonyProvider,
  TextToSpeechProvider,
} from "@tvic/core";
import { sameAudioFormat } from "@tvic/core";

export type RuntimeProvider =
  | TelephonyProvider
  | SpeechToTextProvider
  | TextToSpeechProvider
  | RealtimeModelProvider
  | LLMProvider;

export type ProviderForKind<K extends ProviderKind> = Extract<
  RuntimeProvider,
  { readonly kind: K }
>;

export function isProviderKind<K extends ProviderKind>(
  provider: RuntimeProvider,
  kind: K,
): provider is ProviderForKind<K> {
  return provider.kind === kind;
}

export type AudioFormatDirection = "input" | "output";

export function supportsAudioFormat(
  provider: Provider,
  format: AudioFormat,
  direction: AudioFormatDirection,
): boolean {
  const audio = provider.capabilities.audio;
  if (direction === "input") {
    return audio?.input?.some((candidate) => sameAudioFormat(candidate, format)) ?? false;
  }
  return audio?.output?.some((candidate) => sameAudioFormat(candidate, format)) ?? false;
}

export function supportsLanguage(provider: Provider, language: string): boolean {
  return provider.capabilities.languages?.includes(language) ?? false;
}

export function supportsModel(provider: Provider, model: string): boolean {
  return provider.capabilities.models?.includes(model) ?? false;
}

export function requireProviderKind<K extends ProviderKind>(
  provider: RuntimeProvider,
  kind: K,
): ProviderForKind<K> {
  if (!isProviderKind(provider, kind)) {
    throw new Error(`Expected provider kind ${kind}, received ${provider.kind}`);
  }
  return provider;
}

export {
  TwilioMediaStreamCallHandle,
  TwilioMediaStreamsProvider,
  createTwilioMediaStreamsProvider,
  type TwilioMediaStreamCallHandleOptions,
  type TwilioMediaStreamSocket,
} from "./twilio.js";

export {
  DeepgramSttStream,
  DeepgramSttProvider,
  createDeepgramSttProvider,
  type DeepgramSttProviderOptions,
} from "./deepgram.js";

export {
  OpenAiResponsesLlmProvider,
  createOpenAiResponsesLlmProvider,
  type OpenAiResponsesLlmProviderOptions,
} from "./openai-responses.js";

export {
  CartesiaTtsStream,
  CartesiaTtsProvider,
  createCartesiaTtsProvider,
  type CartesiaTtsProviderOptions,
} from "./cartesia.js";

export type {
  LLMProvider,
  RealtimeModelProvider,
  SpeechToTextProvider,
  TelephonyProvider,
  TextToSpeechProvider,
};
