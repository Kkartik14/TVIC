export { defineTool, type DefineToolInput } from "./define-tool.js";
export { defineAgent, type DefineAgentInput } from "./define-agent.js";
// `createRuntime` (-> Runtime) is the public surface. InMemoryRuntime stays internal —
// its `debugStats()` is a test/diagnostics-only hook, kept off the normal public API.
export { createRuntime } from "./create-runtime.js";
export { ConversationPolicy, type ConversationPolicyOptions } from "./conversation-policy.js";
export {
  PipelineVoiceLoop,
  runPipelineVoiceLoop,
  type PipelineVoiceLoopOptions,
  type PipelineVoiceLoopResult,
} from "./pipeline-loop.js";
export {
  NodeMediaPlane,
  createNodeMediaPlane,
  matchPath,
  type NodeMediaPlaneConnection,
  type NodeMediaPlaneConnectionErrorHandler,
  type NodeMediaPlaneConnectionHandler,
  type NodeMediaPlaneOptions,
  type NodeMediaPlaneRequestHandler,
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
  Subscription,
} from "@tvic/core";
