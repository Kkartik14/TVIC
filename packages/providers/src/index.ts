import type {
  AudioFormat,
  LLMProvider,
  Provider,
  ProviderKind,
  RealtimeModelProvider,
  SpeechToTextProvider,
  TelephonyProvider,
  TextToSpeechProvider,
  TraceExporter,
} from "@tvic/core";

export type RuntimeProvider =
  | TelephonyProvider
  | SpeechToTextProvider
  | TextToSpeechProvider
  | RealtimeModelProvider
  | LLMProvider
  | TraceExporter;

export type ProviderForKind<K extends ProviderKind> = Extract<RuntimeProvider, { readonly kind: K }>;

export function isProviderKind<K extends ProviderKind>(
  provider: RuntimeProvider,
  kind: K,
): provider is ProviderForKind<K> {
  return provider.kind === kind;
}

export function supportsAudioFormat(provider: Provider, format: AudioFormat): boolean {
  return (
    provider.capabilities.audioFormats?.some(
      (candidate) =>
        candidate.encoding === format.encoding &&
        candidate.sampleRateHz === format.sampleRateHz &&
        candidate.channels === format.channels,
    ) ?? false
  );
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

export type {
  LLMProvider,
  RealtimeModelProvider,
  SpeechToTextProvider,
  TelephonyProvider,
  TextToSpeechProvider,
  TraceExporter,
};
