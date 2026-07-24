import type { AudioFormat } from "../audio.js";
import type { SessionId, TurnId } from "../ids.js";
import type { MediaAudioCommittedEvent, OutputAudioChunk } from "../media.js";
import type { Provider } from "../provider.js";
import type { Timestamp } from "../timestamp.js";

export interface TtsSynthesisRequest {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly text: string;
  readonly voice?: string;
  readonly model?: string;
  readonly format: AudioFormat;
  readonly stream: boolean;
  readonly speed?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Aborts startup (e.g. a connect timeout) so a stalled synthesize does not leak. */
  readonly signal?: AbortSignal;
}

export type TtsAlignmentUnit = "word" | "phoneme";

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
  readonly flushId?: number;
}

export interface TtsFlushCompletedEvent {
  readonly type: "tts.flush.completed";
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly sequence: number;
  readonly provider: string;
  readonly timestamp: Timestamp;
  readonly flushId: number;
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

export interface TtsSessionOpenRequest {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly voice?: string;
  readonly model?: string;
  readonly format: AudioFormat;
  readonly speed?: number;
  readonly timestamps?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
}

/** A single prosody-preserving synthesis context receiving incremental text. */
export interface TtsSession extends TtsStream {
  sendText(text: string): Promise<void>;
  /** Creates a provider-acknowledged boundary without ending the context. */
  flush(): Promise<void>;
  /** Ends input; events continue until the provider emits its completion event. */
  finish(): Promise<void>;
}

export interface TextToSpeechProvider extends Provider {
  readonly kind: "tts";
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
