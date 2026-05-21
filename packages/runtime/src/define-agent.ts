import type {
  Agent,
  AgentAudioPolicy,
  AgentId,
  AgentMemoryPolicy,
  AgentRecordingPolicy,
  AgentProviders,
  FallbackPolicy,
  InterruptionPolicy,
  RetryPolicy,
  TimeoutPolicy,
  ToolDefinition,
} from "@tvic/core";

const DEFAULT_INTERRUPTION: InterruptionPolicy = {
  mode: "graceful",
  minSpeechMs: 200,
  cancelOutputOnInterrupt: true,
  trimOutputOnInterrupt: true,
  resumePartialOnEnd: false,
};

const DEFAULT_TIMEOUT: TimeoutPolicy = {
  timeoutMs: 30_000,
  onTimeout: "fail",
};

const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 1,
  initialDelayMs: 0,
  maxDelayMs: 0,
  backoff: "fixed",
  jitter: false,
};

const DEFAULT_MEMORY: AgentMemoryPolicy = {
  enabled: false,
  scopes: [],
};

const DEFAULT_RECORDING: AgentRecordingPolicy = {
  consentMode: "do_not_record",
  persistAudio: false,
  redactPii: true,
};

export interface DefineAgentInput {
  readonly id: string;
  readonly name: string;
  readonly version?: string;
  readonly instructions: string;
  readonly tools: readonly ToolDefinition[];
  readonly providers: AgentProviders;
  readonly audioPolicy: AgentAudioPolicy;
  readonly memoryPolicy?: AgentMemoryPolicy;
  readonly recordingPolicy?: AgentRecordingPolicy;
  readonly interruptionPolicy?: InterruptionPolicy;
  readonly timeoutPolicy?: TimeoutPolicy;
  readonly retryPolicy?: RetryPolicy;
  readonly fallbackPolicy?: FallbackPolicy;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export function defineAgent(input: DefineAgentInput): Agent {
  return {
    id: input.id as AgentId,
    name: input.name,
    version: input.version ?? "0.1.0",
    instructions: input.instructions,
    tools: input.tools,
    providers: input.providers,
    audioPolicy: input.audioPolicy,
    memoryPolicy: input.memoryPolicy ?? DEFAULT_MEMORY,
    recordingPolicy: input.recordingPolicy ?? DEFAULT_RECORDING,
    interruptionPolicy: input.interruptionPolicy ?? DEFAULT_INTERRUPTION,
    timeoutPolicy: input.timeoutPolicy ?? DEFAULT_TIMEOUT,
    retryPolicy: input.retryPolicy ?? DEFAULT_RETRY,
    ...(input.fallbackPolicy ? { fallbackPolicy: input.fallbackPolicy } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}
