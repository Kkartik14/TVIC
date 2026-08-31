export { defineTool, type DefineToolInput } from "./define-tool.js";
export { defineAgent, type DefineAgentInput } from "./define-agent.js";
// `createRuntime` (-> Runtime) is the public surface. InMemoryRuntime stays internal.
// its `debugStats()` is a test/diagnostics-only hook, kept off the normal public API.
export { createRuntime } from "./create-runtime.js";
export type {
  HealthCheckResult,
  HealthSnapshot,
  PreCallContext,
  PreCallContextResolver,
  PreCallMemoryContext,
  PreCallMemoryResolver,
  SessionEndEvent,
  SessionEndMemorySnapshot,
  SessionMetricsRecorder,
} from "@tvic/core";
export {
  formatMemoryContextAsSystemBlock,
  formatPreCallContextAsSystemBlock,
  resolvePreCallContext,
  resolvePreCallMemory,
} from "./memory-loader.js";
export { assertMemoryCapability, assertMemoryPolicySupported } from "./memory-capabilities.js";
export {
  SessionRecoveryCoordinator,
  SessionReaper,
  type RecoveryPollResult,
  type SessionActivator,
  type SessionRecoveryCoordinatorOptions,
  type SessionReaperOptions,
} from "./session-recovery.js";
export { ConversationPolicy, type ConversationPolicyOptions } from "./conversation-policy.js";
export {
  PipelineVoiceLoop,
  runPipelineVoiceLoop,
  type PipelineVoiceLoopOptions,
  type PipelineVoiceLoopResult,
  type TurnLatencyRecord,
} from "./pipeline-loop.js";
export { type AssistantTextRecord } from "./assistant-text.js";
export { deliverAssistantText, shouldDeliverText, type TextDeliveryMode } from "./text-delivery.js";
export {
  createSttSession,
  type AudioNormalizationMode,
  type SttSession,
  type SttSessionInputOptions,
  type SttSessionOptions,
} from "./stt-session.js";
export {
  getSttRecoveryControl,
  withSttReconnect,
  type SttReconnectOptions,
  type SttRecoveryControl,
  type SttRecoveryState,
} from "./resilient-stt.js";
export {
  NodeMediaPlane,
  createNodeMediaPlane,
  matchPath,
  type NodeMediaPlaneConnection,
  type NodeMediaPlaneConnectionErrorHandler,
  type NodeMediaPlaneConnectionHandler,
  type NodeMediaPlaneOptions,
  type NodeMediaPlaneRequestHandler,
  type UpgradeAuthorization,
} from "./node-media-plane.js";

export type {
  Agent,
  EndSessionRequest,
  EndTurnRequest,
  Runtime,
  RuntimeOptions,
  Session,
  SessionSnapshot,
  StartSessionOptions,
  StartTurnRequest,
} from "@tvic/core";
