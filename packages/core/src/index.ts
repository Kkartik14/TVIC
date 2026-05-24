export type { Brand } from "./branded.js";

export type {
  AgentId,
  CallId,
  CorrelationId,
  MediaEventId,
  MemoryEntryId,
  OrganizationId,
  PayloadRef,
  ProviderEventId,
  SessionId,
  SpanId,
  ToolCallId,
  ToolId,
  ToolName,
  TraceEventId,
  TraceId,
  TurnId,
  UserId,
  WorkflowId,
} from "./ids.js";

export type { DurationMs, LatencyMs, Timestamp } from "./timestamp.js";
export { nowTimestamp, toTimestamp } from "./timestamp.js";
export type { Clock } from "./clock.js";
export { createSystemClock, monotonicOffsetMs } from "./clock.js";
export type { CounterIdGenerator, IdGenerator } from "./id-generator.js";
export { counterIdGenerator, createDefaultIdGenerator } from "./id-generator.js";
export type { RuntimeLogger } from "./logger.js";
export type { ErrorCategory, NormalizedError } from "./errors.js";
export {
  isNormalizedError,
  internalError,
  mediaError,
  normalizedError,
  normalizeUnknownError,
  providerError,
  timeoutError,
  unknownErrorMessage,
  validationError,
} from "./errors.js";
export {
  MONO_CHANNELS,
  PCM16_16K_MONO,
  PROVIDER_DEFAULTS,
  PROVIDER_ERROR_CODES,
  PROVIDER_NAMES,
  RUNTIME_SAMPLE_RATE_HZ,
  TELEPHONY_SAMPLE_RATE_HZ,
} from "./constants.js";
export type { CallDirection, ChannelKind, MediaDirection } from "./direction.js";

export type {
  AudioArtifactChunk,
  CallArtifactAudioFile,
  CallArtifactByteRange,
  CallArtifactManifest,
  CallArtifactManifestFile,
  CallArtifactPayload,
  CallArtifactPrivacy,
  CallArtifactSink,
  CallArtifactTraceFile,
} from "./artifact.js";

export type {
  AudioFormat,
  AudioPayload,
  AudioPayloadData,
  ChannelLayout,
  NormalizedAudioEncoding,
  SampleRateHz,
  TransportAudioEncoding,
  TransportAudioFormat,
} from "./audio.js";

export type {
  BackoffStrategy,
  FallbackPolicy,
  IdempotencyPolicy,
  InterruptionMode,
  InterruptionPolicy,
  RetryPolicy,
  TimeoutAction,
  TimeoutPolicy,
} from "./policies.js";

export type {
  BargeInDetectedEvent,
  DtmfDigit,
  DtmfReceivedEvent,
  InputAudioChunk,
  InputMediaEvent,
  InternalMediaEvent,
  MediaAudioChunkEvent,
  MediaAudioCommittedEvent,
  MediaErrorEvent,
  MediaEvent,
  MediaEventType,
  MediaStreamEndedEvent,
  MediaStreamStartedEvent,
  OutputAudioChunk,
  OutputMediaEvent,
  SilenceEndedEvent,
  SilenceStartedEvent,
  SpeechEndedEvent,
  SpeechStartedEvent,
  StreamEndReason,
} from "./media.js";
export { DTMF_DIGITS, isDtmfDigit } from "./media.js";

export type {
  FailedToolCall,
  FailedToolCallStatus,
  JsonSchemaDocument,
  QueuedToolCall,
  RunningToolCall,
  SucceededToolCall,
  ToolCall,
  ToolCallStatus,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutor,
  ToolLogger,
} from "./tool.js";

export type {
  Memory,
  MemoryEntry,
  MemoryPutOptions,
  MemoryQuery,
  MemoryRef,
  MemoryScope,
  MemorySearchResult,
} from "./memory.js";

export type {
  Call,
  CallStatus,
  ConnectedCall,
  CreatedCall,
  EndedCall,
  FailedCall,
  MediaTransport,
  MediaTransportKind,
  RingingCall,
} from "./call.js";

export type {
  ActiveSession,
  CancelledSession,
  CompletedSession,
  CreatedSession,
  FailedSession,
  Session,
  SessionState,
  SessionStatus,
  StartingSession,
  TerminalSession,
  TerminalSessionStatus,
} from "./session.js";

export type {
  ActiveTurn,
  CancelledTurn,
  CompletedTurn,
  FailedTurn,
  TerminalTurn,
  Turn,
  TurnInput,
  TurnLatency,
  TurnOutput,
  TurnStatus,
} from "./turn.js";

export type {
  Agent,
  AgentAudioPolicy,
  AgentMemoryPolicy,
  AgentPipelineProviders,
  AgentProviders,
  AgentRealtimeProviders,
  AgentRecordingPolicy,
  AgentRuntimeMode,
  RecordingConsentMode,
} from "./agent.js";

export type {
  CloseableStream,
  Provider,
  ProviderCapabilities,
  ProviderHealth,
  ProviderKind,
} from "./provider.js";

export type {
  CallHandle,
  InboundCallContext,
  InboundMediaEvent,
  LlmCompletion,
  LlmCompletionRequest,
  LlmInlineToolCall,
  LlmMessage,
  LlmMessageRole,
  LlmStreamEvent,
  LlmUsage,
  LLMProvider,
  OutboundCallRequest,
  RealtimeAudioInputEvent,
  RealtimeAudioOutputEvent,
  RealtimeErrorEvent,
  RealtimeEvent,
  RealtimeModelProvider,
  RealtimeOpenRequest,
  RealtimeOutputCancelledEvent,
  RealtimeSession,
  RealtimeTextEvent,
  RealtimeToolCallEvent,
  SpeechToTextProvider,
  SttOpenRequest,
  SttStream,
  TelephonyProvider,
  TextToSpeechProvider,
  TraceExporter,
  TranscriptEvent,
  TranscriptEventType,
  TtsEvent,
  TtsStream,
  TtsSynthesisRequest,
} from "./providers/index.js";

export type {
  AudioInputChunkTrace,
  AudioInputEndedTrace,
  AudioInputStartedTrace,
  AudioOutputChunkTrace,
  AudioOutputEndedTrace,
  AudioOutputStartedTrace,
  BargeInDetectedTrace,
  BargeInRejectedReason,
  BargeInRejectedTrace,
  CallConnectedTrace,
  CallCreatedTrace,
  CallEndedTrace,
  InterruptDetectedTrace,
  InterruptHandledTrace,
  LlmCompletedTrace,
  LlmFailedTrace,
  LlmStartedTrace,
  LlmTokenTrace,
  MediaStreamEndedTrace,
  MediaStreamStartedTrace,
  MemoryDeleteTrace,
  MemoryReadTrace,
  MemoryWriteTrace,
  OutputCancelledTrace,
  RuntimeFallbackTrace,
  RuntimeRetryTrace,
  RuntimeTimeoutTrace,
  SessionCancelledTrace,
  SessionCompletedTrace,
  SessionCreatedTrace,
  SessionFailedTrace,
  SessionStartedTrace,
  SpeechEndedTrace,
  SpeechStartedTrace,
  SttFailedTrace,
  SttFinalTrace,
  SttPartialTrace,
  SttStartedTrace,
  ToolCancelledTrace,
  ToolCompletedTrace,
  ToolFailedTrace,
  ToolQueuedTrace,
  ToolStartedTrace,
  ToolTimedOutTrace,
  TraceEvent,
  TraceEventStatus,
  TraceEventType,
  TraceQuery,
  TraceRedactor,
  TraceSink,
  TraceStore,
  TurnEndedTrace,
  TurnStartedTrace,
  TtsChunkTrace,
  TtsCompletedTrace,
  TtsFailedTrace,
  TtsStartedTrace,
} from "./trace.js";

export type {
  EndSessionReason,
  EndSessionRequest,
  EndTurnRequest,
  Runtime,
  RuntimeOptions,
  RuntimeServiceLifecycle,
  SessionSnapshot,
  SessionUpdateHandler,
  StartSessionOptions,
  StartTurnRequest,
  Subscription,
  TraceEventHandler,
} from "./runtime.js";

export type {
  SessionRuntimeMetadata,
  SessionStore,
  StoredSessionRecord,
  StoredToolCallRecord,
  StoredTurnRecord,
  ToolCallRuntimeMetadata,
  ToolCallStore,
  TurnRuntimeMetadata,
  TurnStore,
} from "./dal.js";

export type { TerminalSessionDraft } from "./domain.js";
export {
  isTerminalSession,
  isTerminalTurn,
  terminalSessionFromRequest,
  terminalTurnFromRequest,
} from "./domain.js";
