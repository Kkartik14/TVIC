import type { AudioFormat } from "../audio.js";
import type { SessionId, TurnId } from "../ids.js";
import type { MediaAudioCommittedEvent, OutputAudioChunk } from "../media.js";
import type { Provider } from "../provider.js";
import type { Timestamp } from "../timestamp.js";
import type { TtsUsageAccounting, TtsUsageReporter } from "./usage.js";
import type { TtsTextOperation, TtsTextPart } from "../tts-text.js";
import type { TtsPronunciationDictionaryReference, TtsTextNormalization } from "../tts-controls.js";
import type { SpeechControlCatalogSnapshot } from "../speech-controls.js";

export interface TtsSessionOpenRequest {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly voice?: string;
  readonly model?: string;
  readonly language?: string;
  readonly format: AudioFormat;
  readonly speed?: number;
  readonly textNormalization?: TtsTextNormalization;
  readonly pronunciationDictionaries?: readonly TtsPronunciationDictionaryReference[];
  readonly speechControlCatalog?: SpeechControlCatalogSnapshot;
  readonly timestamps?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly usageReporter?: TtsUsageReporter;
  readonly signal?: AbortSignal;
}

export interface TtsSynthesisRequest extends TtsSessionOpenRequest {
  readonly text: string;
  readonly textParts?: readonly TtsTextPart[];
  readonly stream: boolean;
}

export interface TtsProviderSelection {
  readonly model?: string;
  readonly voice?: string;
  readonly language?: string;
  readonly speed?: number;
  readonly textNormalization?: TtsTextNormalization;
  readonly pronunciationDictionaries?: readonly TtsPronunciationDictionaryReference[];
  readonly speechControlCatalog?: SpeechControlCatalogSnapshot;
}

export type TtsAlignmentUnit = "character" | "word" | "phoneme";

export type TtsFlushId = string | number;
export type TtsFlushAcknowledgement = "provider" | "transport";

export interface TtsFlushResult {
  readonly id: TtsFlushId;
  readonly acknowledgedBy: TtsFlushAcknowledgement;
}

export interface TtsAlignmentEvent {
  readonly type: "tts.alignment";
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly sequence: number;
  readonly provider: string;
  readonly timestamp: Timestamp;
  readonly unit: TtsAlignmentUnit;
  readonly tokens: readonly string[];
  readonly startMs: readonly number[];
  readonly endMs: readonly number[];
  readonly flushId?: TtsFlushId;
}

export interface TtsFlushCompletedEvent {
  readonly type: "tts.flush.completed";
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly sequence: number;
  readonly provider: string;
  readonly timestamp: Timestamp;
  readonly flushId: TtsFlushId;
  readonly acknowledgedBy: TtsFlushAcknowledgement;
}

export type TtsEvent =
  | OutputAudioChunk
  | MediaAudioCommittedEvent
  | TtsAlignmentEvent
  | TtsFlushCompletedEvent;

export interface TtsStream {
  readonly events: AsyncIterable<TtsEvent>;
  cancel(): Promise<void>;
}

export interface TtsSession extends TtsStream {
  sendText(text: string): Promise<void>;
  sendTextParts?(parts: readonly TtsTextPart[]): Promise<void>;
  flush(): Promise<TtsFlushResult>;
  finish(): Promise<void>;
}

export interface TextToSpeechProvider extends Provider {
  readonly kind: "tts";
  readonly accountVoiceCatalogProviders?: readonly string[];
  readonly accountVoiceCatalogControls?: readonly string[];
  readonly ttsVoiceIdsForSelection?: (
    selection: TtsProviderSelection,
  ) => readonly string[] | undefined;
  readonly configuredModelSource?: "configured" | "not_reported";
  readonly usageAccounting?: TtsUsageAccounting;
  readonly supportsTtsSelection?: (selection: TtsProviderSelection) => boolean;
  readonly supportsTtsTextOperations?: (
    operations: readonly TtsTextOperation[],
    selection: TtsProviderSelection,
  ) => boolean;
  readonly supportsTtsTextNormalization?: (
    normalization: TtsTextNormalization,
    selection: TtsProviderSelection,
  ) => boolean;
  readonly supportsTtsPronunciationDictionaries?: (
    dictionaries: readonly TtsPronunciationDictionaryReference[],
    selection: TtsProviderSelection,
  ) => boolean;
  synthesize(request: TtsSynthesisRequest): Promise<TtsStream>;
}

export interface IncrementalTextToSpeechProvider extends TextToSpeechProvider {
  openSession(request: TtsSessionOpenRequest): Promise<TtsSession>;
}

export function isIncrementalTextToSpeechProvider(
  provider: TextToSpeechProvider,
): provider is IncrementalTextToSpeechProvider {
  return "openSession" in provider && typeof provider.openSession === "function";
}
