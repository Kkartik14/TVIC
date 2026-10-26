import type {
  AudioFormat,
  IncrementalTextToSpeechProvider,
  LLMProvider,
  Provider,
  ProviderKind,
  SpeechToTextProvider,
  SttBatchTimestampGranularity,
  SttBatchTranscription,
  SttBatchTranscriptionRequest,
  SttBatchWord,
  TelephonyProvider,
  TextToSpeechProvider,
} from "@tvic/core";
import { sameAudioFormat, TvicThrowableError, validationError } from "@tvic/core";

export type RuntimeProvider =
  | TelephonyProvider
  | SpeechToTextProvider
  | TextToSpeechProvider
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

export function supportsLanguage(
  provider: Provider,
  language: string,
  model?: string,
  voice?: string,
): boolean {
  if (provider.supportsLanguage) return provider.supportsLanguage(language, model, voice);
  return provider.capabilities.languages?.includes(language) ?? false;
}

export function supportsModel(provider: Provider, model: string): boolean {
  return provider.capabilities.models?.includes(model) ?? false;
}

export function supportsBatchModel(provider: Provider, model: string): boolean {
  return provider.capabilities.batchModels?.includes(model) ?? false;
}

export function requireProviderKind<K extends ProviderKind>(
  provider: RuntimeProvider,
  kind: K,
): ProviderForKind<K> {
  if (!isProviderKind(provider, kind)) {
    throw TvicThrowableError.from(
      validationError(
        "provider.kind_mismatch",
        `Expected provider kind ${kind}, received ${provider.kind}`,
        { metadata: { expected: kind, received: provider.kind } },
      ),
    );
  }
  return provider;
}

export {
  TwilioMediaStreamCallHandle,
  TWILIO_MAX_AUDIO_EVENT_BYTES,
  type TwilioMediaStreamCallHandleOptions,
  type TwilioMediaStreamSocket,
} from "./twilio.js";

export {
  TWILIO_CAPABILITIES,
  TwilioMediaStreamsProvider,
  createTwilioMediaStreamsProvider,
} from "./twilio-provider.js";

export {
  WEB_CLIENT_AUDIO_CLOSE_CODES,
  WEB_CLIENT_AUDIO_DEFAULTS,
  WEB_CLIENT_AUDIO_ACK_RETENTION_MS,
  WebClientAudioCallHandle,
  WebClientAudioProvider,
  createWebClientAudioProvider,
  type ConnectionObservabilityEvent,
  type WebClientAudioCallHandleOptions,
  type WebClientAudioConnectionEvent,
  type WebClientAudioProviderOptions,
  type WebClientAudioSocket,
} from "./web-client-audio.js";

export {
  DeepgramSttStream,
  DeepgramSttProvider,
  MAX_PROVIDER_AUDIO_OFFSET_MS,
  createDeepgramSttProvider,
  type DeepgramSttProviderOptions,
} from "./deepgram.js";

export {
  CartesiaSttStream,
  CartesiaSttProvider,
  createCartesiaSttProvider,
  cartesiaSttProviderError,
  type CartesiaSttMode,
  type CartesiaSttProviderOptions,
} from "./cartesia-stt.js";

export {
  SarvamSttStream,
  SarvamSttProvider,
  createSarvamSttProvider,
  type SarvamOutputMode,
  type SarvamSttProviderOptions,
} from "./sarvam.js";

export {
  SarvamTtsStream,
  SarvamTtsProvider,
  createSarvamTtsProvider,
  type SarvamTtsProviderOptions,
} from "./sarvam-tts.js";

export {
  SARVAM_TTS_LANGUAGES,
  SARVAM_TTS_VOICES,
  isSarvamTtsLanguageSupported,
  isSarvamTtsVoiceSupported,
  resolveSarvamTtsVoice,
  type SarvamTtsLanguage,
  type SarvamTtsVoice,
} from "./sarvam-tts-model.js";

export {
  SARVAM_TTS_V4_FLASH_MODEL,
  SARVAM_TTS_V4_FLASH_VOICES,
  SARVAM_TTS_V4_FLASH_VOICE_CASES,
  type SarvamTtsV4FlashVoice,
  type SarvamTtsV4FlashVoiceCase,
} from "./sarvam-tts-v4-voices.js";

export {
  SarvamTtsHttpStream,
  SarvamTtsHttpStreamProvider,
  SarvamTtsRestProvider,
  createSarvamTtsHttpStreamProvider,
  createSarvamTtsRestProvider,
  type SarvamTtsHttpProviderOptions,
} from "./sarvam-tts-http.js";

export {
  ElevenLabsSttStream,
  ElevenLabsSttProvider,
  createElevenLabsSttProvider,
  type ElevenLabsBatchSttRequest,
  type ElevenLabsBatchSttResult,
  type ElevenLabsBatchTimestampGranularity,
  type ElevenLabsEntityDetection,
  type ElevenLabsSttCommitStrategy,
  type ElevenLabsSttProviderOptions,
} from "./elevenlabs-stt.js";

export {
  AssemblyAiSttStream,
  AssemblyAiSttProvider,
  createAssemblyAiSttProvider,
  type AssemblyAiPreRecordedModel,
  type AssemblyAiPreRecordedSttRequest,
  type AssemblyAiPreRecordedSttResult,
  type AssemblyAiPiiSubstitution,
  type AssemblyAiRedactedAudioQuality,
  type AssemblyAiRedactPiiAudioOptions,
  type AssemblyAiSpeakerOptions,
  type AssemblyAiSyncModel,
  type AssemblyAiSyncLiveSttRequest,
  type AssemblyAiSyncSttRequest,
  type AssemblyAiSyncSttResult,
  type AssemblyAiTranscriptUtterance,
  type AssemblyAiTranscriptWord,
  type AssemblyAiSttProviderOptions,
} from "./assemblyai-stt.js";

export {
  SonioxSttStream,
  SonioxSttProvider,
  createSonioxSttProvider,
  type SonioxSttProviderOptions,
  type SonioxStructuredContext,
} from "./soniox-stt.js";

export {
  OpenAiResponsesLlmProvider,
  createOpenAiResponsesLlmProvider,
  type OpenAiResponsesLlmProviderOptions,
} from "./openai-responses.js";

export {
  GroqChatLlmProvider,
  createGroqChatLlmProvider,
  type GroqChatLlmProviderOptions,
} from "./groq-chat.js";

export {
  CartesiaTtsStream,
  CartesiaTtsProvider,
  MAX_CARTESIA_INPUT_UTF16_CODE_UNITS,
  MAX_CARTESIA_INPUT_UTF8_BYTES,
  createCartesiaTtsProvider,
  type CartesiaGenerationConfig,
  type CartesiaTtsProviderOptions,
} from "./cartesia.js";

export { CARTESIA_CAPABILITY_FEATURES } from "./cartesia-capability-features.js";
export { ELEVENLABS_CAPABILITY_FEATURES } from "./elevenlabs-capability-features.js";

export {
  loadCartesiaCapabilitySnapshot,
  MAX_CARTESIA_SNAPSHOT_MODEL_IDS,
  MAX_CARTESIA_SNAPSHOT_VOICE_IDS,
  MAX_CARTESIA_SNAPSHOT_VOICE_MODEL_PAIRS,
  type LoadCartesiaCapabilitySnapshotOptions,
} from "./cartesia-capability-snapshot.js";

export {
  loadElevenLabsCapabilitySnapshot,
  MAX_ELEVENLABS_SNAPSHOT_MODEL_IDS,
  MAX_ELEVENLABS_SNAPSHOT_RESPONSE_BYTES,
  MAX_ELEVENLABS_SNAPSHOT_VOICE_IDS,
  MAX_ELEVENLABS_SNAPSHOT_VOICE_MODEL_PAIRS,
  type LoadElevenLabsCapabilitySnapshotOptions,
} from "./elevenlabs-capability-snapshot.js";

export {
  ADAPTER_DEFAULTS,
  ASSEMBLYAI_MODELS,
  ASSEMBLYAI_PRE_RECORDED_MODELS,
  ASSEMBLYAI_REALTIME_MODELS,
  ASSEMBLYAI_SYNC_MODELS,
  PROVIDER_API_VERSIONS,
  PROVIDER_CATALOG,
  PROVIDER_STABILITY,
  PROVIDER_STABILITY_LEVELS,
  type ProviderCatalogEntry,
  type ProviderStability,
} from "./catalog.js";

export {
  ElevenLabsTtsStream,
  ElevenLabsTtsProvider,
  createElevenLabsTtsProvider,
  type ElevenLabsDialogueTurnOptions,
  type ElevenLabsPronunciationDictionaryLocator,
  type ElevenLabsTextNormalization,
  type ElevenLabsTtsSendTextOptions,
  type ElevenLabsTtsProviderOptions,
} from "./elevenlabs.js";

export {
  ELEVENLABS_DIALOGUE_MAX_CHARACTERS,
  ELEVENLABS_DIALOGUE_MAX_VOICES,
  ELEVENLABS_TTS_CHARACTER_LIMITS,
  ELEVENLABS_TTS_PCM_OUTPUT_FORMAT,
  ElevenLabsTtsHttpStreamProvider,
  ElevenLabsTtsRestProvider,
  createElevenLabsTtsHttpStreamProvider,
  createElevenLabsTtsRestProvider,
  type ElevenLabsDialogueInput,
  type ElevenLabsDialogueProvider,
  type ElevenLabsDialogueSynthesisRequest,
  type ElevenLabsHttpTtsProviderOptions,
  type ElevenLabsTtsHttpSynthesisRequest,
} from "./elevenlabs-http.js";

export {
  ElevenLabsMultiContextProvider,
  createElevenLabsDialogueMultiContextProvider,
  createElevenLabsMultiContextProvider,
  createElevenLabsTtsMultiContextProvider,
  type ElevenLabsMultiContextOpenRequest,
  type ElevenLabsMultiContextProtocol,
  type ElevenLabsMultiContextProviderOptions,
  type ElevenLabsMultiContextSendTextOptions,
  type ElevenLabsMultiContextSession,
  type ElevenLabsTtsMultiContextConnection,
} from "./elevenlabs-multi-context.js";

export {
  createTtsFailoverProvider,
  type TtsFailoverContext,
  type TtsFailoverPhase,
  type TtsFailoverProviderOptions,
  type TtsFailoverVoiceMapping,
} from "./tts-failover.js";

export type {
  IncrementalTextToSpeechProvider,
  LLMProvider,
  SpeechToTextProvider,
  SttBatchTimestampGranularity,
  SttBatchTranscription,
  SttBatchTranscriptionRequest,
  SttBatchWord,
  TelephonyProvider,
  TextToSpeechProvider,
};

export { AsyncQueue, AsyncQueueConsumerError } from "./async-queue.js";

export {
  classifyProviderError,
  classifiedProviderError,
  readBoundedProviderErrorBody,
  MAX_PROVIDER_ERROR_BODY_BYTES,
  MAX_PROVIDER_ERROR_CODE_CHARS,
  MAX_PROVIDER_ERROR_FIELD_CHARS,
  type ProviderErrorClassification,
  type ProviderErrorClassificationInput,
} from "./provider-error-classifier.js";

export { SystemProviderClock, type ProviderClock } from "./common.js";

export {
  canonicalizeTwilioData,
  computeTwilioSignature,
  verifyTwilioSignature,
  type TwilioFlatParams,
  type TwilioParamValue,
  type TwilioParams,
  type VerifyTwilioOptions,
} from "./twilio-webhooks.js";

export {
  signVoiceSessionToken,
  verifyVoiceSessionToken,
  type VerifyVoiceSessionTokenOptions,
} from "./web-client-audio-webhooks.js";
