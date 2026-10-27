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
  readonly language?: string;
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
  /**
   * Optional language-provenance hint for wrappers such as provider failover.
   * Preserve it when forwarding a request. The runtime sets this value; direct
   * callers may omit it or set it to match whether they selected the language.
   */
  readonly selectionContext?: TtsProviderSelectionContext;
}

export interface TtsProviderSelection {
  readonly model?: string;
  readonly voice?: string;
  readonly language?: string;
  readonly speed?: number;
}

/** Provenance for selection hooks; configured defaults are not caller choices. */
export interface TtsProviderSelectionContext {
  /** True when the language came from a per-call override or host-supplied default. */
  readonly languageWasExplicitlySelected?: boolean;
  /** True only when this call's user or caller selected the language. */
  readonly languageWasCallerSelected: boolean;
  /** Call-scoped capability facts that can prove snapshot-dependent support. */
  readonly providerCapabilitySnapshots?: readonly ProviderCapabilitySnapshot[];
  /** Time at which providerCapabilitySnapshots are evaluated, in Unix milliseconds. */
  readonly providerCapabilityEvaluationTimeMs?: number;
}

/** Details used to explain a missing language in a composed TTS selection. */
export interface TtsLanguageRequirementDescription {
  readonly provider?: string;
  readonly model?: string;
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
  /** Preflights the complete per-call selection when the adapter can do so. */
  readonly supportsTtsSelection?: (
    selection: TtsProviderSelection,
    context?: TtsProviderSelectionContext,
  ) => boolean;
  /** Reports whether a model requires an explicit language in the resolved call. */
  readonly requiresTtsLanguageForModel?: (model?: string) => boolean;
  /** Reports a language requirement for a complete selection, including conditional routes. */
  readonly requiresTtsLanguageForSelection?: (
    selection: TtsProviderSelection,
    context?: TtsProviderSelectionContext,
  ) => boolean;
  /** Describes which composed route requires a language for preflight diagnostics. */
  readonly describeTtsLanguageRequirement?: (
    selection: TtsProviderSelection,
    context?: TtsProviderSelectionContext,
  ) => TtsLanguageRequirementDescription | undefined;
  /** Reports whether a model requires callers to select a voice. */
  readonly requiresTtsVoiceForModel?: (model?: string) => boolean;
  /** Maximum characters accepted in one text submission, when provider-specific. */
  readonly maxTtsTextCharacters?: (model?: string, voice?: string) => number | undefined;
  /** Reports support for a language with optional model and voice context. */
  readonly supportsTtsLanguage?: (
    language: string,
    model?: string,
    voice?: string,
    context?: TtsProviderSelectionContext,
  ) => boolean;
  /** Reports support for a speed with optional model and voice context. */
  readonly supportsTtsSpeed?: (
    speed: number,
    model?: string,
    voice?: string,
    context?: TtsProviderSelectionContext,
  ) => boolean;
  readonly supportsTtsVoiceOverride?: (
    voice: string,
    model?: string,
    language?: string,
    context?: TtsProviderSelectionContext,
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
