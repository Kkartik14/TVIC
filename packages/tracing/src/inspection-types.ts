import type {
  CallArtifactManifest,
  MediaEventId,
  SpanId,
  Timestamp,
  ToolCallId,
  TraceEventId,
  TraceEventStatus,
  TraceId,
  TurnId,
} from "@tvic/core";

import type { CallTimeline } from "./analysis.js";
import type { SpanView } from "./spans.js";
import type { FailureExplanation, IncidentView } from "./failure.js";

// ---------- View-model types ----------
// The stable, UI-ready shapes the trace viewer renders. No logic lives here; all
// derivation is in inspection.ts / turn-analysis.ts.

export type CallStatus = "completed" | "failed" | "cancelled" | "active" | "unknown";
export type TurnInspectionStatus = "completed" | "failed" | "cancelled" | "active";
export type TurnTag = "tool" | "interrupted" | "failed" | "cancelled" | "completed";

export interface LlmPassTiming {
  readonly passIndex: number;
  readonly kind: "initial" | "post_tool";
  readonly spanId: SpanId;
  readonly startedMs?: number;
  readonly firstTokenMs?: number;
  readonly completedMs?: number;
  readonly durationMs?: number;
  readonly toolCallIds: readonly ToolCallId[];
  /**
   * True when this post-tool pass follows a failed tool result the model recovered
   * from. Derived (not a distinct runtime-emitted LLM pass).
   */
  readonly recoveredFromToolFailure: boolean;
  readonly status: TraceEventStatus;
}

export interface LatencyBreakdown {
  /** Overlapping tags — a tool turn can also be interrupted or failed. */
  readonly turnTags: readonly TurnTag[];
  /** Endpoint delay (last speech frame -> commit). Null until VAD/endpoint events exist. */
  readonly endpointMs: number | null;
  readonly endpointAvailable: boolean;
  /** Absolute call-clock offset of the committing stt.final (the EOU marker). */
  readonly endOfUtteranceMs?: number;
  /** Endpoint -> stt.final. Unavailable (undefined) until endpoint events exist. */
  readonly sttFinalMs?: number;
  /** First LLM pass TTFT (EOU -> first token of the turn). */
  readonly llmTtftMs?: number;
  readonly llmTotalMs?: number;
  readonly llmPasses: readonly LlmPassTiming[];
  readonly toolMs?: number;
  readonly ttsTtfbMs?: number;
  readonly ttsTotalMs?: number;
  /** EOU -> first audio out (the headline response latency). */
  readonly firstAudioMs?: number;
  /** Playout duration from audio.output completion — not first-audio-to-confirmation. */
  readonly playoutMs?: number;
  /** Always derived (turn.ended duration, or observed span). */
  readonly totalMs: number;
  readonly bottleneck?: { readonly stage: string; readonly ms: number };
  readonly warnings: readonly string[];
}

export interface ToolCallView {
  readonly toolCallId: ToolCallId;
  readonly toolName: string;
  readonly status: "succeeded" | "failed" | "timed_out" | "cancelled";
  readonly attempts: number;
  readonly startedMs?: number;
  readonly durationMs?: number;
}

export type PlayoutState = "heard" | "unconfirmed" | "cancelled" | "none";

export interface PlayoutView {
  readonly state: PlayoutState;
  readonly framesSent: number;
  readonly playedMs?: number;
}

export interface InterruptionView {
  readonly turnId: TurnId;
  readonly detectedMs?: number;
  readonly handledMs?: number;
  readonly cancelledOutputMs?: number;
  readonly latencyMs?: number;
  readonly framesSent?: number;
  /** Derived from output-active / sent frames; does not claim byte-level heard audio. */
  readonly wasSpeaking: boolean;
  readonly framesSentBeforeCancel?: number;
  readonly reason?: string;
  readonly status: "handled" | "rejected" | "detected";
  readonly evidenceEventIds: readonly TraceEventId[];
}

export type ReplaySegmentKind =
  | "caller_speech"
  | "agent_sent"
  | "agent_heard"
  | "interruption"
  | "failure"
  | "tool_wait"
  | "silence";

export type ReplayTrack = "caller" | "agent" | "none";

export interface ReplaySegment {
  readonly id: string;
  readonly kind: ReplaySegmentKind;
  readonly label: string;
  readonly track: ReplayTrack;
  /** Call-clock monotonicOffsetMs — the seek contract; matches the aligned audio route. */
  readonly startMs: number;
  readonly endMs: number;
  readonly turnId?: TurnId;
  readonly spanId?: SpanId;
  readonly mediaEventIds: readonly MediaEventId[];
  readonly available: boolean;
  readonly unavailableReason?: string;
}

export interface MemoryWriteView {
  readonly key: string;
  readonly scope: string;
  readonly mode: "put" | "append";
  readonly atMs: number;
}

export interface TurnInspection {
  readonly turnId: TurnId;
  readonly sequence?: number;
  readonly status: TurnInspectionStatus;
  readonly startedMs: number;
  readonly endedMs: number;
  readonly durationMs: number;
  readonly callerText?: string;
  readonly agentText?: string;
  readonly latency: LatencyBreakdown;
  readonly spans: readonly SpanView[];
  readonly tools: readonly ToolCallView[];
  readonly interruptions: readonly InterruptionView[];
  readonly playout: PlayoutView;
  readonly memoryWrites: readonly MemoryWriteView[];
  readonly failure?: FailureExplanation;
  readonly incidents: readonly IncidentView[];
  readonly replaySegments: readonly ReplaySegment[];
  readonly evidenceEventIds: readonly TraceEventId[];
}

export interface RecordingSummary {
  readonly consentMode: "record" | "do_not_record" | "unknown";
  readonly persistAudio: boolean;
  readonly redactPii: boolean;
  readonly audioAvailable: boolean;
  readonly inputTrackAvailable: boolean;
  readonly outputTrackAvailable: boolean;
}

export interface CallSummary {
  readonly turnCount: number;
  readonly completedTurns: number;
  readonly failedTurns: number;
  readonly cancelledTurns: number;
  readonly interruptionCount: number;
  readonly toolCallCount: number;
  readonly retryCount: number;
  readonly incidentCount: number;
  readonly completedTurnsWithIncidents: number;
  readonly averageResponseLatencyMs?: number;
  readonly slowestTurnId?: TurnId;
  readonly primaryFailure?: FailureExplanation;
}

/** The display-safe projection of a trace event used to render evidence in UI panels. */
export interface EvidenceView {
  readonly eventId: TraceEventId;
  readonly type: string;
  readonly offsetMs: number;
  readonly status: string;
  readonly provider?: string;
  readonly code?: string;
  readonly message?: string;
  readonly spanId?: SpanId;
}

export interface CallInspection {
  readonly callId?: string;
  readonly traceId?: TraceId;
  readonly status: CallStatus;
  readonly startedAt?: Timestamp;
  readonly endedAt?: Timestamp;
  /** Call-clock origin (min monotonicOffsetMs); the audio route aligns to this. */
  readonly startMs: number;
  readonly endMs: number;
  readonly durationMs: number;
  readonly degraded: boolean;
  readonly artifactWarnings: readonly string[];
  readonly summary: CallSummary;
  readonly turns: readonly TurnInspection[];
  /** The legacy waterfall timeline, reused so existing renderers keep working. */
  readonly timeline: CallTimeline;
  readonly recording: RecordingSummary;
  readonly replay: readonly ReplaySegment[];
  /**
   * Display-safe evidence lookup so UI panels resolve `evidenceEventIds` without the raw
   * trace map (transcripts, provider metadata, payloads) being hydrated into the client.
   */
  readonly evidenceById: Readonly<Record<string, EvidenceView>>;
  readonly rawEventCount: number;
}

export interface DeriveCallInspectionOptions {
  readonly callId?: string;
  readonly manifest?: CallArtifactManifest | null;
  /** True when a manifest was expected but absent (close() never finished). */
  readonly manifestMissing?: boolean;
  readonly inputTrackAvailable?: boolean;
  readonly outputTrackAvailable?: boolean;
  readonly artifactWarnings?: readonly string[];
  /** Trace lines dropped by the loader as corrupt/invalid — makes the call degraded. */
  readonly droppedEventCount?: number;
}

/** Per-turn artifact availability passed into turn analysis (controls replay segments). */
export interface TurnArtifactAvailability {
  readonly inputTrackAvailable: boolean;
  readonly outputTrackAvailable: boolean;
}
