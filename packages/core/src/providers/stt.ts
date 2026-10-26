import type { AudioFormat } from "../audio.js";
import type { SessionId } from "../ids.js";
import type { InputAudioChunk } from "../media.js";
import type { Provider } from "../provider.js";
import type { TranscriptEvent } from "./transcript.js";
import type { ProviderUsageReporter, SttUsageAccounting, SttUsageReporter } from "./usage.js";

export const MAX_STT_LANGUAGE_HINTS = 16;

export type SttLanguagePolicy =
  | { readonly mode: "fixed"; readonly language: string }
  | { readonly mode: "auto" }
  | {
      readonly mode: "hints";
      readonly languages: readonly string[];
      readonly strictness?: "best_effort";
    };

export interface SttOpenRequest {
  readonly sessionId: SessionId;
  readonly format: AudioFormat;
  readonly language?: string;
  readonly languagePolicy?: SttLanguagePolicy;
  readonly model?: string;
  readonly allowUnknownModel?: boolean;
  readonly interimResults: boolean;
  readonly vocabulary?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly usageReporter?: SttUsageReporter;
  readonly signal?: AbortSignal;
}

export type SttBatchTimestampGranularity = "word";

export interface SttBatchTranscriptionRequest {
  readonly audio: Uint8Array;
  readonly fileName?: string;
  readonly mimeType?: string;
  readonly format?: AudioFormat;
  readonly language?: string;
  readonly model?: string;
  readonly timestampGranularities?: readonly SttBatchTimestampGranularity[];
  readonly allowUnknownModel?: boolean;
  readonly signal?: AbortSignal;
  readonly usageReporter?: ProviderUsageReporter;
}

export interface SttBatchWord {
  readonly word: string;
  readonly startMs: number;
  readonly endMs: number;
}

export interface SttBatchTranscription {
  readonly text: string;
  readonly requestId?: string;
  readonly language?: string;
  readonly durationMs?: number;
  readonly words?: readonly SttBatchWord[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type SttCommitMode = "provider" | "none";
export type SttTimestampOrigin = "session" | "generation";
export const STT_STREAM_ENDED_REASON = "stream_ended";

export interface SttStream {
  readonly events: AsyncIterable<TranscriptEvent>;
  readonly commitMode?: SttCommitMode;
  readonly timestampOrigin?: SttTimestampOrigin;
  sendAudio(chunk: InputAudioChunk): Promise<void>;
  updateAgentContext?(context: string): Promise<void>;
  commit(): Promise<void>;
  close(): Promise<void>;
}

export interface SpeechToTextProvider extends Provider {
  readonly kind: "stt";
  readonly usageAccounting?: SttUsageAccounting;
  readonly supportsSttLanguagePolicy?: (policy: SttLanguagePolicy, model?: string) => boolean;
  readonly supportsSttVocabulary?: (vocabulary: readonly string[], model?: string) => boolean;
  readonly supportsSttAgentContext?: (model?: string) => boolean;
  open(request: SttOpenRequest): Promise<SttStream>;
  transcribe?(request: SttBatchTranscriptionRequest): Promise<SttBatchTranscription>;
}
