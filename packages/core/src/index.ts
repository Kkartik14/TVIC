export type { Brand } from "./branded.js";

export type {
  AgentId,
  CallId,
  MediaEventId,
  MemoryEntryId,
  OrganizationId,
  ProviderEventId,
  SessionId,
  ToolCallId,
  ToolId,
  ToolName,
  TurnId,
  UserId,
  WorkflowId,
} from "./ids.js";

export type { Timestamp } from "./timestamp.js";
export { nowTimestamp, toTimestamp } from "./timestamp.js";
export {
  canonicalizeLanguageTag,
  languageTagCandidates,
  normalizeLanguageStringMap,
  normalizeStrictLanguageTag,
  primaryLanguageSubtag,
} from "./language.js";
export type { LanguageStringMapNormalization, StrictLanguageTagNormalization } from "./language.js";
export type { Clock } from "./clock.js";
export { createSystemClock, monotonicOffsetMs } from "./clock.js";
export type { CounterIdGenerator, IdGenerator } from "./id-generator.js";
export { counterIdGenerator, createDefaultIdGenerator } from "./id-generator.js";
export type { ErrorCategory, NormalizedError, TvicErrorName } from "./errors.js";
export {
  BackendUnavailableError,
  CorruptRecordError,
  DurableError,
  InvalidArgumentError,
  LeaseLostError,
  LeaseUnavailableError,
  MemoryBackendUnavailableError,
  MemoryEntryTooLargeError,
  MemorySessionQuotaExceededError,
  RecordConflictError,
  RecordNotFoundError,
  type DurableErrorCode,
} from "./dal-errors.js";
export {
  TVIC_ERROR_MARKER,
  TVIC_ERROR_NAMES,
  TvicThrowableError,
  authError,
  cancelledError,
  connectionError,
  interruptedError,
  isValidErrorCode,
  jsonSerializableNormalizedError,
  normalizedErrorFromTvicError,
  isNormalizedError,
  MAX_ERROR_CODE_UTF8_BYTES,
  isTvicError,
  isTvicErrorName,
  internalError,
  mediaError,
  normalizedError,
  normalizeLegacyError,
  normalizeUnknownError,
  providerError,
  rateLimitError,
  signatureError,
  timeoutError,
  toolError,
  tvicErrorFromJSON,
  unknownErrorMessage,
  validationError,
} from "./errors.js";
export {
  PCM16_8K_MONO,
  PCM16_16K_MONO,
  STT_ERROR_CODES,
  TVIC_ERROR_CODE_ALIASES,
  TVIC_ERROR_CODES,
  PROVIDER_ERROR_CODES,
  PROVIDER_NAMES,
  RUNTIME_SAMPLE_RATE_HZ,
  TELEPHONY_SAMPLE_RATE_HZ,
} from "./constants.js";
export type { CallDirection, ChannelKind, MediaDirection } from "./direction.js";

export type {
  AudioFormat,
  AudioPayload,
  ChannelLayout,
  NormalizedAudioEncoding,
  SampleRateHz,
  TransportAudioEncoding,
  TransportAudioFormat,
} from "./audio.js";
export { isReconstructableAudioFormat, isSampleRateHz } from "./audio.js";

export type {
  BackoffStrategy,
  IdempotencyPolicy,
  InterruptionMode,
  InterruptionPolicy,
  RetryPolicy,
  TimeoutAction,
  TimeoutPolicy,
} from "./policies.js";

export type {
  AnyMediaEventInit,
  DtmfDigit,
  DtmfReceivedEvent,
  InputAudioChunk,
  InputMediaEvent,
  InterruptRequestedEvent,
  InternalMediaEvent,
  MediaAudioChunkEvent,
  MediaAudioCommittedEvent,
  MediaErrorEvent,
  MediaEvent,
  MediaEventKind,
  MediaEventType,
  MediaStreamEndedEvent,
  MediaStreamStartedEvent,
  OutputAudioChunk,
  OutputMediaEvent,
  StreamEndReason,
  TurnCommitRequestedEvent,
} from "./media.js";
export {
  DTMF_DIGITS,
  EVENT_KIND_MAP,
  createMediaEvent,
  isDtmfDigit,
  kindForMediaEvent,
} from "./media.js";

export type {
  FailedToolCall,
  FailedToolCallStatus,
  JsonSchemaDocument,
  QueuedToolCall,
  RunningToolCall,
  SucceededToolCall,
  TerminalToolCall,
  ToolCall,
  ToolCallStatus,
  ToolDefinition,
  ToolExecutionContext,
  ToolTenant,
  ToolExecutor,
  ToolLogger,
  ToolIdempotencyClaim,
  ToolIdempotencyClaimResult,
  ToolIdempotencyLease,
  ToolIdempotencyLookupResult,
  ToolIdempotencyOutcome,
  ToolIdempotencyQuarantine,
  ToolIdempotencyQuarantineResult,
  ToolIdempotencyRelease,
  ToolIdempotencyRecord,
  ToolIdempotencyStatus,
  ToolIdempotencyStore,
} from "./tool.js";

export type {
  Memory,
  MemoryCapabilities,
  MemoryEntry,
  MemoryKind,
  MemoryPutOptions,
  MemoryQuery,
  MemoryRef,
  MemoryScope,
  JsonValue,
} from "./memory.js";

export type {
  Call,
  CallSnapshot,
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
  SessionCancellationReason,
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
  AudioOutputDeliveryStatus,
  TextOutputDeliveryStatus,
  TurnOutputDelivery,
  TurnOutput,
  TurnStatus,
  TurnCancellationReason,
} from "./turn.js";

export type {
  Agent,
  AgentAudioPolicy,
  AgentContextPolicy,
  AgentMemoryPolicy,
  AgentProviders,
  PersonaConfig,
} from "./agent.js";

export type {
  CallControlCapability,
  Provider,
  ProviderBatchCapabilities,
  ProviderAudioCapabilities,
  ProviderCapabilities,
  ProviderCancellationCapabilities,
  ProviderCompatibility,
  ProviderCompatibilityIssue,
  ProviderCompatibilityIssueCode,
  ProviderDataPolicy,
  ProviderKind,
  ProviderPlayoutCapabilities,
  ProviderRequirements,
  RequiredProviderCapabilities,
  ProviderStreamingCapabilities,
  ProviderToolCapabilities,
  ProviderTurnProfileCapability,
  ProviderTtsSpeedRange,
  ProviderTtsTextControlCapability,
  ProviderTtsVoiceCapabilityRequirement,
  ProviderTtsVoiceMapping,
  ProviderVoiceSelection,
  ProviderTransport,
  TurnTakingProfile,
  TurnDetectionMode,
} from "./provider.js";
export {
  createProviderTtsVoiceMappings,
  evaluateProviderCompatibility,
  MAX_PROVIDER_TTS_SPEED_RANGES,
  MAX_PROVIDER_TTS_VOICE_MAPPINGS,
  sameAudioFormat,
} from "./provider.js";

export {
  createProviderCapabilitySnapshot,
  createProviderCapabilitySnapshots,
  MAX_PROVIDER_CAPABILITY_FACTS,
  MAX_PROVIDER_CAPABILITY_FEATURE_LENGTH,
  MAX_PROVIDER_CAPABILITY_IDENTIFIER_LENGTH,
  MAX_PROVIDER_CAPABILITY_PROVIDER_LENGTH,
  MAX_PROVIDER_CAPABILITY_SOURCE_LENGTH,
  MAX_PROVIDER_CAPABILITY_SNAPSHOTS,
  MAX_PROVIDER_CAPABILITY_TOTAL_FACTS,
  MAX_PROVIDER_CAPABILITY_TOTAL_TEXT_BYTES,
  MAX_PROVIDER_CAPABILITY_VALUE_ITEMS,
  PROVIDER_CAPABILITY_FEATURES,
  resolveProviderCapability,
} from "./provider-capability-snapshot.js";
export type {
  ProviderCapabilityFact,
  ProviderCapabilityQuery,
  ProviderCapabilityResolution,
  ProviderCapabilityScope,
  ProviderCapabilitySnapshot,
  ProviderCapabilityStatus,
  ProviderCapabilityValue,
} from "./provider-capability-snapshot.js";

export type {
  CallHandle,
  InboundCallContext,
  InboundMediaEvent,
  IncrementalTextToSpeechProvider,
  LlmCompletion,
  LlmCompletionRequest,
  LlmInlineToolCall,
  LlmMessage,
  LlmMessageRole,
  LlmStreamEvent,
  LlmUsage,
  LLMProvider,
  OutboundCallRequest,
  SpeechToTextProvider,
  SttBatchTimestampGranularity,
  SttBatchTranscription,
  SttBatchTranscriptionRequest,
  SttBatchWord,
  SttCommitMode,
  SttLanguagePolicy,
  SttOpenRequest,
  SttTimestampOrigin,
  SttStream,
  TelephonyProvider,
  TextToSpeechProvider,
  TranscriptEndpointEvent,
  TranscriptEndpointReason,
  TranscriptEvent,
  TranscriptEventType,
  TranscriptSegmentEvent,
  TranscriptSegmentEventType,
  TranscriptSpeechStartedEvent,
  TtsEvent,
  ProviderCapabilitySnapshotVoice,
  TtsAlignmentEvent,
  TtsAlignmentUnit,
  TtsFlushCompletedEvent,
  TtsFlushAcknowledgement,
  TtsFlushId,
  TtsFlushResult,
  TtsSession,
  TtsSessionOpenRequest,
  TtsProviderSelection,
  TtsProviderSelectionContext,
  TtsLanguageRequirementDescription,
  TtsStream,
  TtsSynthesisRequest,
  TtsTextControl,
  TtsTextControlKind,
} from "./providers/index.js";
export { isIncrementalTextToSpeechProvider, isTranscriptSegmentEvent } from "./providers/index.js";
/** @internal Shared implementation helpers for TVIC runtime and adapters. */
export { evaluateTtsSelectionCompatibility } from "./providers/tts-selection-compatibility.js";
/** @internal Shared implementation policy for the selection evaluator. */
export type {
  TtsSelectionCompatibilityIssue,
  TtsSelectionCompatibilityOptions,
  TtsSelectionRequirement,
} from "./providers/tts-selection-compatibility.js";
export { MAX_STT_LANGUAGE_HINTS, STT_STREAM_ENDED_REASON } from "./providers/stt.js";
export {
  countUnicodeCodePoints,
  MAX_SESSION_USAGE_ENTRIES,
  MAX_SESSION_USAGE_IDENTIFIER_LENGTH,
  MAX_SESSION_USAGE_METRICS_PER_ENTRY,
  MAX_USAGE_OBSERVATION_SAMPLES,
} from "./providers/usage.js";
export {
  MAX_TTS_TEXT_CONTROL_MATCH_CODE_POINTS,
  MAX_TTS_TEXT_CONTROL_PAUSE_MS,
  MAX_TTS_TEXT_CONTROLS,
  normalizeTtsTextControls,
} from "./providers/tts-text-controls.js";
export type {
  LlmUsageReport,
  MissingUsageOperation,
  ProviderUsageField,
  ProviderUsageObservation,
  ProviderUsageOperation,
  ProviderUsageReporter,
  SessionUsageEntry,
  SessionUsageSummary,
  SttAudioWriteUsageOperation,
  SttUsageAccounting,
  SttUsageReporter,
  TtsUsageAccounting,
  TtsUsageReporter,
  UsageMetric,
  UsageModelOrigin,
  UsageModelSource,
  UsageNotReportedReason,
  UsageUnit,
} from "./providers/usage.js";

export type {
  AudioTapSummary,
  DurableRuntimePolicy,
  DurableRuntimeMetric,
  EndSessionReason,
  EndSessionRequest,
  EndTurnRequest,
  HealthCheckResult,
  HealthSnapshot,
  PreCallContext,
  PreCallContextResolver,
  PreCallMemoryContext,
  PreCallMemoryResolver,
  Runtime,
  RuntimeOptions,
  TerminalSource,
  SessionEndEvent,
  SessionEndMemorySnapshot,
  SessionMemoryFinalization,
  SessionMetricsRecorder,
  RuntimeObservation,
  RuntimeObservationInput,
  RuntimeObservationName,
  RuntimePipelineObservationInput,
  RuntimePipelineObservationName,
  RuntimeObservationSink,
  RuntimeObservationStats,
  RuntimeObservationValue,
  RuntimeSessionTrace,
  RuntimeTraceError,
  RuntimeServiceLifecycle,
  SessionAttachment,
  SessionAttachmentHealth,
  SessionSnapshot,
  StartAttachedSessionOptions,
  StartSessionOptions,
  StartTurnRequest,
} from "./runtime.js";
export { RUNTIME_OBSERVATION_NAMES, RUNTIME_OBSERVATION_SCHEMA_VERSION } from "./runtime.js";
export { DEFAULT_DURABLE_RUNTIME_POLICY } from "./runtime.js";

export type {
  DurableOutboxEvent,
  DurableRuntimeStore,
  DurableSessionTransaction,
  SessionLease,
  SessionLeaseStore,
  SessionRecoveryCandidate,
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
export {
  assertLeaseFence,
  assertLeaseTimestampMs,
  assertLeaseTtlMs,
  assertRecoveryPageSize,
  MAX_RECOVERY_PAGE_SIZE,
  MAX_SAFE_LEASE_TIMESTAMP,
  safeLeaseExpiryAt,
} from "./dal.js";

export type { TerminalSessionDraft } from "./domain.js";
export {
  isTerminalSession,
  isTerminalTurn,
  terminalSessionFromRequest,
  terminalSourceForRequest,
  terminalTurnFromRequest,
} from "./domain.js";
