import type { NormalizedError } from "./errors.js";
import type {
  AgentId,
  CallId,
  CorrelationId,
  MediaEventId,
  PayloadRef,
  SessionId,
  SpanId,
  ToolCallId,
  ToolId,
  ToolName,
  TraceEventId,
  TraceId,
  TurnId,
} from "./ids.js";
import type { MemoryRef, MemoryScope } from "./memory.js";
import type { Timestamp } from "./timestamp.js";

interface TraceEventCore {
  readonly id: TraceEventId;
  readonly traceId: TraceId;
  readonly sessionId: SessionId;
  readonly timestamp: Timestamp;
  readonly monotonicOffsetMs: number;
  readonly spanId: SpanId;
  readonly correlationId: CorrelationId;
  readonly parentSpanId?: SpanId;
  readonly parentEventId?: TraceEventId;
  readonly provider?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ---------- Session ----------

export interface SessionCreatedTrace extends TraceEventCore {
  readonly type: "session.created";
  readonly status: "succeeded";
  readonly agentId: AgentId;
}

export interface SessionStartedTrace extends TraceEventCore {
  readonly type: "session.started";
  readonly status: "succeeded";
}

export interface SessionCompletedTrace extends TraceEventCore {
  readonly type: "session.completed";
  readonly status: "succeeded";
  readonly durationMs: number;
}

export interface SessionFailedTrace extends TraceEventCore {
  readonly type: "session.failed";
  readonly status: "failed";
  readonly durationMs: number;
  readonly error: NormalizedError;
}

export interface SessionCancelledTrace extends TraceEventCore {
  readonly type: "session.cancelled";
  readonly status: "cancelled";
  readonly durationMs: number;
  readonly cancelReason: string;
}

// ---------- Turn ----------

export interface TurnStartedTrace extends TraceEventCore {
  readonly type: "turn.started";
  readonly status: "started";
  readonly turnId: TurnId;
  readonly sequence: number;
}

interface TurnEndedTraceCore extends TraceEventCore {
  readonly type: "turn.ended";
  readonly turnId: TurnId;
  readonly durationMs: number;
}

export interface TurnEndedSucceededTrace extends TurnEndedTraceCore {
  readonly status: "succeeded";
}

export interface TurnEndedFailedTrace extends TurnEndedTraceCore {
  readonly status: "failed";
  readonly error: NormalizedError;
}

export interface TurnEndedCancelledTrace extends TurnEndedTraceCore {
  readonly status: "cancelled";
  readonly reason: string;
}

export type TurnEndedTrace =
  | TurnEndedSucceededTrace
  | TurnEndedFailedTrace
  | TurnEndedCancelledTrace;

// ---------- Call ----------

export interface CallCreatedTrace extends TraceEventCore {
  readonly type: "call.created";
  readonly status: "succeeded";
  readonly callId: CallId;
}

export interface CallConnectedTrace extends TraceEventCore {
  readonly type: "call.connected";
  readonly status: "succeeded";
  readonly callId: CallId;
}

interface CallEndedTraceCore extends TraceEventCore {
  readonly type: "call.ended";
  readonly callId: CallId;
  readonly durationMs: number;
}

export interface CallEndedSucceededTrace extends CallEndedTraceCore {
  readonly status: "succeeded";
}

export interface CallEndedFailedTrace extends CallEndedTraceCore {
  readonly status: "failed";
  readonly error: NormalizedError;
}

export type CallEndedTrace = CallEndedSucceededTrace | CallEndedFailedTrace;

// ---------- Media stream ----------

export interface MediaStreamStartedTrace extends TraceEventCore {
  readonly type: "media.stream.started";
  readonly status: "succeeded";
  readonly direction: "input" | "output";
  readonly callId?: CallId;
}

interface MediaStreamEndedTraceCore extends TraceEventCore {
  readonly type: "media.stream.ended";
  readonly direction: "input" | "output";
  readonly callId?: CallId;
  readonly durationMs: number;
}

export interface MediaStreamEndedSucceededTrace extends MediaStreamEndedTraceCore {
  readonly status: "succeeded";
}

export interface MediaStreamEndedFailedTrace extends MediaStreamEndedTraceCore {
  readonly status: "failed";
  readonly error: NormalizedError;
}

export type MediaStreamEndedTrace = MediaStreamEndedSucceededTrace | MediaStreamEndedFailedTrace;

// ---------- Audio input ----------

export interface AudioInputStartedTrace extends TraceEventCore {
  readonly type: "audio.input.started";
  readonly status: "started";
  readonly turnId?: TurnId;
}

export interface AudioInputChunkTrace extends TraceEventCore {
  readonly type: "audio.input.chunk";
  readonly status: "in_progress";
  readonly turnId?: TurnId;
  readonly mediaEventId: MediaEventId;
  readonly frameCount: number;
  readonly durationMs: number;
}

export interface AudioInputEndedTrace extends TraceEventCore {
  readonly type: "audio.input.ended";
  readonly status: "succeeded";
  readonly turnId?: TurnId;
  readonly durationMs: number;
}

// ---------- Audio output ----------

export interface AudioOutputStartedTrace extends TraceEventCore {
  readonly type: "audio.output.started";
  readonly status: "started";
  readonly turnId: TurnId;
}

export interface AudioOutputChunkTrace extends TraceEventCore {
  readonly type: "audio.output.chunk";
  readonly status: "in_progress";
  readonly turnId: TurnId;
  readonly mediaEventId: MediaEventId;
  readonly frameCount: number;
  readonly durationMs: number;
}

export interface AudioOutputEndedTrace extends TraceEventCore {
  readonly type: "audio.output.ended";
  readonly status: "succeeded" | "cancelled";
  readonly turnId: TurnId;
  readonly durationMs: number;
}

// ---------- Speech detection ----------

export interface SpeechStartedTrace extends TraceEventCore {
  readonly type: "speech.started";
  readonly status: "started";
  readonly turnId?: TurnId;
}

export interface SpeechEndedTrace extends TraceEventCore {
  readonly type: "speech.ended";
  readonly status: "succeeded";
  readonly turnId?: TurnId;
  readonly durationMs: number;
}

// ---------- STT ----------

export interface SttStartedTrace extends TraceEventCore {
  readonly type: "stt.started";
  readonly status: "started";
  readonly turnId: TurnId;
}

export interface SttPartialTrace extends TraceEventCore {
  readonly type: "stt.partial";
  readonly status: "in_progress";
  readonly turnId: TurnId;
  readonly text: string;
  readonly confidence?: number;
}

export interface SttFinalTrace extends TraceEventCore {
  readonly type: "stt.final";
  readonly status: "succeeded";
  readonly turnId: TurnId;
  readonly text: string;
  readonly confidence?: number;
  readonly durationMs: number;
}

export interface SttFailedTrace extends TraceEventCore {
  readonly type: "stt.failed";
  readonly status: "failed";
  readonly turnId: TurnId;
  readonly durationMs: number;
  readonly error: NormalizedError;
}

// ---------- LLM ----------

export interface LlmStartedTrace extends TraceEventCore {
  readonly type: "llm.started";
  readonly status: "started";
  readonly turnId: TurnId;
  readonly model: string;
  readonly inputRef?: PayloadRef;
}

export interface LlmTokenTrace extends TraceEventCore {
  readonly type: "llm.token";
  readonly status: "in_progress";
  readonly turnId: TurnId;
  readonly text: string;
}

export interface LlmCompletedTrace extends TraceEventCore {
  readonly type: "llm.completed";
  readonly status: "succeeded";
  readonly turnId: TurnId;
  readonly model: string;
  readonly durationMs: number;
  /**
   * Final assistant text for the pass. Carried so the inspection viewer can show the
   * agent transcript even for providers that deliver text only on completion (no
   * streamed `llm.token` events). Audio/large payloads still use `outputRef`.
   */
  readonly text?: string;
  readonly outputRef?: PayloadRef;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface LlmFailedTrace extends TraceEventCore {
  readonly type: "llm.failed";
  readonly status: "failed";
  readonly turnId: TurnId;
  readonly model: string;
  readonly durationMs: number;
  readonly error: NormalizedError;
}

// ---------- Tool ----------

interface ToolTraceCore extends TraceEventCore {
  readonly toolId: ToolId;
  readonly toolName: ToolName;
  readonly toolCallId: ToolCallId;
  readonly turnId: TurnId;
}

export interface ToolQueuedTrace extends ToolTraceCore {
  readonly type: "tool.queued";
  readonly status: "started";
  readonly attempt: number;
}

export interface ToolStartedTrace extends ToolTraceCore {
  readonly type: "tool.started";
  readonly status: "in_progress";
  readonly attempt: number;
  readonly inputRef?: PayloadRef;
}

export interface ToolCompletedTrace extends ToolTraceCore {
  readonly type: "tool.completed";
  readonly status: "succeeded";
  readonly attempt: number;
  readonly durationMs: number;
  readonly outputRef?: PayloadRef;
}

export interface ToolFailedTrace extends ToolTraceCore {
  readonly type: "tool.failed";
  readonly status: "failed";
  readonly attempt: number;
  readonly durationMs: number;
  readonly error: NormalizedError;
}

export interface ToolTimedOutTrace extends ToolTraceCore {
  readonly type: "tool.timed_out";
  readonly status: "failed";
  readonly attempt: number;
  readonly durationMs: number;
  readonly error: NormalizedError;
}

export interface ToolCancelledTrace extends ToolTraceCore {
  readonly type: "tool.cancelled";
  readonly status: "cancelled";
  readonly attempt: number;
  readonly durationMs: number;
  readonly reason: string;
}

// ---------- TTS ----------

export interface TtsStartedTrace extends TraceEventCore {
  readonly type: "tts.started";
  readonly status: "started";
  readonly turnId: TurnId;
  readonly voice?: string;
  readonly inputRef?: PayloadRef;
}

export interface TtsChunkTrace extends TraceEventCore {
  readonly type: "tts.chunk";
  readonly status: "in_progress";
  readonly turnId: TurnId;
  readonly mediaEventId: MediaEventId;
  readonly frameCount: number;
  readonly durationMs: number;
}

export interface TtsCompletedTrace extends TraceEventCore {
  readonly type: "tts.completed";
  readonly status: "succeeded";
  readonly turnId: TurnId;
  readonly durationMs: number;
  readonly totalFrames: number;
}

export interface TtsFailedTrace extends TraceEventCore {
  readonly type: "tts.failed";
  readonly status: "failed";
  readonly turnId: TurnId;
  readonly durationMs: number;
  readonly error: NormalizedError;
}

// ---------- Interruption ----------

export interface BargeInDetectedTrace extends TraceEventCore {
  readonly type: "barge_in.detected";
  readonly status: "succeeded";
  readonly turnId: TurnId;
  readonly confidence: number;
}

export type BargeInRejectedReason =
  | "min_speech_not_met"
  | "below_echo_floor"
  | "stt_not_confirmed"
  | "policy_ignored";

export interface BargeInRejectedTrace extends TraceEventCore {
  readonly type: "barge_in.rejected";
  readonly status: "cancelled";
  readonly turnId?: TurnId;
  readonly confidence: number;
  readonly reason: BargeInRejectedReason;
}

export interface InterruptDetectedTrace extends TraceEventCore {
  readonly type: "interrupt.detected";
  readonly status: "succeeded";
  readonly turnId: TurnId;
  readonly cause: "barge_in" | "dtmf" | "explicit" | "timeout";
}

export interface InterruptHandledTrace extends TraceEventCore {
  readonly type: "interrupt.handled";
  readonly status: "succeeded";
  readonly turnId: TurnId;
  readonly durationMs: number;
  readonly outputCancelled: boolean;
}

export interface OutputCancelledTrace extends TraceEventCore {
  readonly type: "output.cancelled";
  readonly status: "cancelled";
  readonly turnId: TurnId;
  /**
   * Frames we had streamed to the channel before cancelling. This is an upper
   * bound on audio actually discarded; precise drop counts require telephony
   * mark/ack reconciliation (future work).
   */
  readonly framesSent: number;
  readonly durationMs: number;
}

// ---------- Memory ----------

interface MemoryTraceCore extends TraceEventCore {
  readonly memoryRef: MemoryRef;
  readonly key: string;
  readonly scope: MemoryScope;
}

interface MemoryReadTraceCore extends MemoryTraceCore {
  readonly type: "memory.read";
  readonly hit: boolean;
}

export interface MemoryReadSucceededTrace extends MemoryReadTraceCore {
  readonly status: "succeeded";
}

export interface MemoryReadFailedTrace extends MemoryReadTraceCore {
  readonly status: "failed";
  readonly error: NormalizedError;
}

export type MemoryReadTrace = MemoryReadSucceededTrace | MemoryReadFailedTrace;

interface MemoryWriteTraceCore extends MemoryTraceCore {
  readonly type: "memory.write";
  readonly mode: "put" | "append";
}

export interface MemoryWriteSucceededTrace extends MemoryWriteTraceCore {
  readonly status: "succeeded";
}

export interface MemoryWriteFailedTrace extends MemoryWriteTraceCore {
  readonly status: "failed";
  readonly error: NormalizedError;
}

export type MemoryWriteTrace = MemoryWriteSucceededTrace | MemoryWriteFailedTrace;

interface MemoryDeleteTraceCore extends MemoryTraceCore {
  readonly type: "memory.delete";
  readonly existed: boolean;
}

export interface MemoryDeleteSucceededTrace extends MemoryDeleteTraceCore {
  readonly status: "succeeded";
}

export interface MemoryDeleteFailedTrace extends MemoryDeleteTraceCore {
  readonly status: "failed";
  readonly error: NormalizedError;
}

export type MemoryDeleteTrace = MemoryDeleteSucceededTrace | MemoryDeleteFailedTrace;

// ---------- Runtime ----------

export interface RuntimeRetryTrace extends TraceEventCore {
  readonly type: "runtime.retry";
  readonly status: "in_progress";
  readonly operation: string;
  readonly attempt: number;
  readonly delayMs: number;
  readonly cause: NormalizedError;
}

export interface RuntimeTimeoutTrace extends TraceEventCore {
  readonly type: "runtime.timeout";
  readonly status: "failed";
  readonly operation: string;
  readonly timeoutMs: number;
  /**
   * Pipeline stage that stalled (v0.3 — provider stall evidence). When present, a
   * provider stream (LLM/TTS) produced no event within `timeoutMs`. Absent for
   * non-provider timeouts such as `telephony.clear`.
   */
  readonly stage?: "llm" | "tts" | "stt";
  /**
   * Timeout policy action taken: `fail` failed the turn, `interrupt` cancelled it
   * (cancel reason `timeout`). Lets the analyzer classify the terminal state.
   */
  readonly policyAction?: "fail" | "interrupt";
  /** Turn the stalled provider stream belonged to, when the timeout is turn-scoped. */
  readonly turnId?: TurnId;
}

export interface RuntimeFallbackTrace extends TraceEventCore {
  readonly type: "runtime.fallback";
  readonly status: "in_progress";
  readonly operation: string;
  readonly fromProvider: string;
  readonly toProvider: string;
  readonly cause: NormalizedError;
}

// ---------- Union ----------

export type TraceEvent =
  | SessionCreatedTrace
  | SessionStartedTrace
  | SessionCompletedTrace
  | SessionFailedTrace
  | SessionCancelledTrace
  | TurnStartedTrace
  | TurnEndedTrace
  | CallCreatedTrace
  | CallConnectedTrace
  | CallEndedTrace
  | MediaStreamStartedTrace
  | MediaStreamEndedTrace
  | AudioInputStartedTrace
  | AudioInputChunkTrace
  | AudioInputEndedTrace
  | AudioOutputStartedTrace
  | AudioOutputChunkTrace
  | AudioOutputEndedTrace
  | SpeechStartedTrace
  | SpeechEndedTrace
  | SttStartedTrace
  | SttPartialTrace
  | SttFinalTrace
  | SttFailedTrace
  | LlmStartedTrace
  | LlmTokenTrace
  | LlmCompletedTrace
  | LlmFailedTrace
  | ToolQueuedTrace
  | ToolStartedTrace
  | ToolCompletedTrace
  | ToolFailedTrace
  | ToolTimedOutTrace
  | ToolCancelledTrace
  | TtsStartedTrace
  | TtsChunkTrace
  | TtsCompletedTrace
  | TtsFailedTrace
  | BargeInDetectedTrace
  | BargeInRejectedTrace
  | InterruptDetectedTrace
  | InterruptHandledTrace
  | OutputCancelledTrace
  | MemoryReadTrace
  | MemoryWriteTrace
  | MemoryDeleteTrace
  | RuntimeRetryTrace
  | RuntimeTimeoutTrace
  | RuntimeFallbackTrace;

export type TraceEventType = TraceEvent["type"];
export type TraceEventStatus = TraceEvent["status"];

export interface TraceSink {
  emit(event: TraceEvent): void;
  flush(): Promise<void>;
}

export interface TraceQuery {
  readonly sessionId?: SessionId;
  readonly traceId?: TraceId;
  readonly types?: readonly TraceEventType[];
  readonly spanId?: SpanId;
  readonly correlationId?: CorrelationId;
  readonly since?: Timestamp;
  readonly until?: Timestamp;
  readonly monotonicSinceMs?: number;
  readonly monotonicUntilMs?: number;
  readonly limit?: number;
}

export type TraceRedactor = (event: TraceEvent) => TraceEvent | null;

export interface TraceStore {
  append(event: TraceEvent): Promise<void>;
  query(query: TraceQuery): Promise<readonly TraceEvent[]>;
  close(): Promise<void>;
}
