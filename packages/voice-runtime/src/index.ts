export {
  createVoiceAgent,
  type AssemblyAiProviderConfig,
  type CartesiaProviderConfig,
  type CreateVoiceAgentOptions,
  type DeepgramProviderConfig,
  type ElevenLabsSttProviderConfig,
  type ElevenLabsTtsProviderConfig,
  type LlmProviderConfig,
  type OpenAiProviderConfig,
  type SarvamProviderConfig,
  type SonioxProviderConfig,
  type SttProviderConfig,
  type TelephonyProviderConfig,
  type TtsProviderConfig,
  type VoiceAgent,
  type VoiceAgentCallHandleContext,
  type VoiceAgentCallHandleFactory,
  type VoiceAgentModels,
  type VoiceAgentProviderNames,
  type VoiceAgentProviders,
  type VoiceAgentRun,
  type VoiceAgentRunOptions,
  type VoiceAgentSession,
} from "./managed-agent.js";

// Stable composable runtime surface. These exports intentionally live at the
// package root; there are no advanced subpaths in the public package.
export {
  assertMemoryCapability,
  assertMemoryPolicySupported,
  ConversationPolicy,
  createNodeMediaPlane,
  createRuntime,
  createSttSession,
  defineAgent,
  defineTool,
  deliverAssistantText,
  formatMemoryContextAsSystemBlock,
  formatPreCallContextAsSystemBlock,
  getSttRecoveryControl,
  matchPath,
  NodeMediaPlane,
  PipelineVoiceLoop,
  PipelineVoiceLoopBuilder,
  resolvePreCallContext,
  resolvePreCallMemory,
  SessionRecoveryCoordinator,
  SessionReaper,
  shouldDeliverText,
  withSttReconnect,
} from "@tvic/runtime";
export type {
  AssistantTextRecord,
  AudioNormalizationMode,
  ConversationPolicyOptions,
  DefineAgentInput,
  DefineToolInput,
  DualProtocolResult,
  HealthCheckResult,
  HealthSnapshot,
  NodeMediaPlaneConnection,
  NodeMediaPlaneConnectionErrorHandler,
  NodeMediaPlaneConnectionHandler,
  NodeMediaPlaneOptions,
  NodeMediaPlaneRequestHandler,
  PipelineVoiceLoopOptions,
  PipelineVoiceLoopResult,
  RecoveryPollResult,
  SessionEndEvent,
  SessionEndMemorySnapshot,
  SessionMetricsRecorder,
  SessionReaperOptions,
  SessionRecoveryCoordinatorOptions,
  SttReconnectOptions,
  SttRecoveryControl,
  SttRecoveryState,
  SttSession,
  SttSessionInputOptions,
  SttSessionOptions,
  TextDeliveryMode,
  TurnLatencyRecord,
  VoiceEvent,
} from "@tvic/runtime";

// Domain contracts and normalized errors are part of the root compatibility
// surface. Keeping this as a single export also preserves the existing type
// relationships used by custom adapters.
export * from "@tvic/core";

export {
  assertPcm16leFormat,
  base64ToBytes,
  bytesToBase64,
  createAudioNormalizer,
  durationMsForPcm16le,
  frameCountForPcm16le,
  isInputMediaEvent,
  isOutputMediaEvent,
  mulawToPcm16le,
  pcm16leToMulaw,
  resamplePcm16le,
  splitPcm16leFrames,
} from "@tvic/media";
export type { AudioNormalizer, AudioNormalizerOptions } from "@tvic/media";
export { AsyncQueue } from "@tvic/media";

export {
  ADAPTER_DEFAULTS,
  AssemblyAiSttProvider,
  CartesiaTtsProvider,
  DeepgramSttProvider,
  ElevenLabsSttProvider,
  ElevenLabsTtsProvider,
  PROVIDER_API_VERSIONS,
  PROVIDER_CATALOG,
  PROVIDER_STABILITY,
  SarvamSttProvider,
  SonioxSttProvider,
  TwilioMediaStreamCallHandle,
  TwilioMediaStreamsProvider,
  WebClientAudioCallHandle,
  WebClientAudioProvider,
  WEB_CLIENT_AUDIO_CLOSE_CODES,
  WEB_CLIENT_AUDIO_DEFAULTS,
  canonicalizeTwilioData,
  computeTwilioSignature,
  createAssemblyAiSttProvider,
  createCartesiaTtsProvider,
  createDeepgramSttProvider,
  createElevenLabsSttProvider,
  createElevenLabsTtsProvider,
  createOpenAiResponsesLlmProvider,
  createSarvamSttProvider,
  createSonioxSttProvider,
  createTwilioMediaStreamsProvider,
  createWebClientAudioProvider,
  isProviderKind,
  requireProviderKind,
  signVoiceSessionToken,
  supportsAudioFormat,
  supportsLanguage,
  supportsModel,
  verifyTwilioSignature,
  verifyVoiceSessionToken,
} from "@tvic/providers";
export type {
  AssemblyAiSttProviderOptions,
  CartesiaTtsProviderOptions,
  ConnectionObservabilityEvent,
  DeepgramSttProviderOptions,
  ElevenLabsSttCommitStrategy,
  ElevenLabsSttProviderOptions,
  ElevenLabsTtsProviderOptions,
  OpenAiResponsesLlmProviderOptions,
  ProviderCatalogEntry,
  ProviderStability,
  ProviderForKind,
  RuntimeProvider,
  SarvamOutputMode,
  SarvamSttProviderOptions,
  SonioxStructuredContext,
  SonioxSttProviderOptions,
  TwilioFlatParams,
  TwilioMediaStreamCallHandleOptions,
  TwilioMediaStreamSocket,
  TwilioParamValue,
  TwilioParams,
  VerifyTwilioOptions,
  VerifyVoiceSessionTokenOptions,
  WebClientAudioCallHandleOptions,
  WebClientAudioConnectionEvent,
  WebClientAudioProviderOptions,
  WebClientAudioSocket,
} from "@tvic/providers";

export {
  InMemoryMemory,
  InMemorySessionLeaseStore,
  InMemorySessionStore,
  InMemoryToolCallStore,
  InMemoryTurnStore,
  createInMemoryDurableRuntimeStore,
  createInMemoryMemory,
  createInMemorySessionStore,
  createInMemoryToolCallStore,
  createInMemoryTurnStore,
} from "@tvic/dal";
export type {
  InMemoryDurableRuntimeStore,
  InMemoryDurableRuntimeStoreOptions,
  InMemoryMemoryOptions,
} from "@tvic/dal";

export {
  InMemoryToolIdempotencyStore,
  createToolRegistry,
  executeTool,
  idempotencyKeyFor,
  idempotencyRequestHashFor,
  stableStringify,
  toolInputError,
  validateJsonSchemaSubset,
} from "@tvic/tools";
export type { ExecuteToolInput, SchemaValidationResult, ToolRegistry } from "@tvic/tools";

export { createPostgresDurableRuntimeStore, runPostgresMigrations } from "@tvic/dal-postgres";
export type {
  PostgresDurableStoreOptions,
  SqlClient,
  SqlPool,
  SqlResult,
} from "@tvic/dal-postgres";

export { createRedisDurableRuntimeStore } from "@tvic/dal-redis";
export type {
  RedisClient,
  RedisMulti,
  RedisScanOptions,
  RedisSetResult,
  RedisStoreOptions,
} from "@tvic/dal-redis";

export { createPostgresRedisDurableRuntimeStore } from "@tvic/dal-composite";
export type { PostgresRedisDurableStoreOptions } from "@tvic/dal-composite";

export { createPostgresMemory, runPostgresMemoryMigrations } from "@tvic/dal-postgres-memory";
export type { PostgresMemoryOptions, PostgresMigration } from "@tvic/dal-postgres-memory";
