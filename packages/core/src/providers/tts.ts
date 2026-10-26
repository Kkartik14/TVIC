import type { AudioFormat } from "../audio.js";
import type { SessionId, TurnId } from "../ids.js";
import type { MediaAudioCommittedEvent, OutputAudioChunk } from "../media.js";
import type { Provider } from "../provider.js";
import type { ProviderCapabilitySnapshot } from "../provider-capability-snapshot.js";
import type { Timestamp } from "../timestamp.js";
import type { TtsUsageAccounting, TtsUsageReporter } from "./usage.js";
import type { TtsTextControl } from "./tts-text-controls.js";

export interface TtsSessionOpenRequest {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly voice?: string;
  readonly model?: string;
  readonly format: AudioFormat;
  readonly speed?: number;
  readonly textControls?: readonly TtsTextControl[];
  readonly providerCapabilitySnapshots?: readonly ProviderCapabilitySnapshot[];
  readonly providerCapabilityEvaluationTimeMs?: number;
  readonly timestamps?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly usageReporter?: TtsUsageReporter;
  readonly signal?: AbortSignal;
}

export interface TtsSynthesisRequest extends TtsSessionOpenRequest {
  readonly text: string;
  readonly stream: boolean;
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

/** A voice selection whose account-level capability fact must be checked. */
export interface ProviderCapabilitySnapshotVoice {
  readonly provider: string;
  readonly model?: string;
  readonly voice: string;
  /** Whether model is fixed by a failover mapping or follows the selected request model. */
  readonly modelSource?: "selected" | "mapped";
  /** The failover child that owns the selection, when this is a wrapped provider. */
  readonly side?: "primary" | "fallback";
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
  flush(): Promise<TtsFlushResult>;
  finish(): Promise<void>;
}

export interface TextToSpeechProvider extends Provider {
  readonly kind: "tts";
  readonly configuredModelSource?: "configured" | "not_reported";
  readonly usageAccounting?: TtsUsageAccounting;
  /** Additional provider snapshots this adapter may inspect or forward during synthesis. */
  readonly providerCapabilitySnapshotProviders?: readonly string[];
  /** Provider/model/voice selections that must be checked before startup. */
  readonly providerCapabilitySnapshotVoices?: readonly ProviderCapabilitySnapshotVoice[];
  /** Requires declared fallback voice mappings whenever capability snapshots are enforced. */
  readonly requiresDeclaredTtsVoiceMappingForCapabilitySnapshots?: boolean;
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
