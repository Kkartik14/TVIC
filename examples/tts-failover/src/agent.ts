import {
  createTtsFailoverProvider,
  createVoiceAgent,
  type CreateVoiceAgentOptions,
  type TextToSpeechProvider,
  type TtsFailoverProviderOptions,
  type VoiceAgent,
} from "voice-runtime";

/**
 * This is application code, not a Sarvam-specific TVIC API. The application
 * supplies every provider and every provider-specific model/voice mapping.
 */
export type CreateFailoverVoiceAgentOptions = Omit<
  CreateVoiceAgentOptions,
  "models" | "providers"
> & {
  readonly providers: Omit<CreateVoiceAgentOptions["providers"], "tts">;
  readonly primaryTts: TextToSpeechProvider;
  readonly fallbackTts: TextToSpeechProvider;
  readonly primaryTtsModel: string;
  readonly primaryTtsVoice: string;
  readonly fallbackTtsModel: string;
  readonly fallbackTtsVoice: string;
  readonly models?: Omit<NonNullable<CreateVoiceAgentOptions["models"]>, "tts" | "ttsVoice">;
  readonly onFallback?: TtsFailoverProviderOptions["onFallback"];
};

export function createFailoverVoiceAgent(options: CreateFailoverVoiceAgentOptions): VoiceAgent {
  const {
    providers,
    primaryTts,
    fallbackTts,
    primaryTtsModel,
    primaryTtsVoice,
    fallbackTtsModel,
    fallbackTtsVoice,
    models,
    onFallback,
    ...agentOptions
  } = options;

  const tts = createTtsFailoverProvider({
    primary: primaryTts,
    fallback: fallbackTts,
    mapFallbackRequest: (request) => ({
      ...request,
      model: fallbackTtsModel,
      voice: fallbackTtsVoice,
    }),
    ...(onFallback ? { onFallback } : {}),
  });

  return createVoiceAgent({
    ...agentOptions,
    providers: { ...providers, tts },
    models: {
      ...models,
      tts: primaryTtsModel,
      ttsVoice: primaryTtsVoice,
    },
  });
}
