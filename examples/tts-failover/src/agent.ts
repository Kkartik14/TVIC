import {
  createTtsFailoverProvider,
  createVoiceAgent,
  type CreateVoiceAgentOptions,
  type TextToSpeechProvider,
  type TtsFailoverProviderOptions,
  type VoiceAgent,
} from "voice-runtime";

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
  readonly languageMatch?: TtsFailoverProviderOptions["languageMatch"];
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
    languageMatch,
    models,
    onFallback,
    ...agentOptions
  } = options;

  const tts = createTtsFailoverProvider({
    primary: primaryTts,
    fallback: fallbackTts,
    ...(languageMatch ? { languageMatch } : {}),
    fallbackVoiceMappings: [
      {
        requestedModel: primaryTtsModel,
        requestedVoice: primaryTtsVoice,
        model: fallbackTtsModel,
        voice: fallbackTtsVoice,
      },
    ],
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
