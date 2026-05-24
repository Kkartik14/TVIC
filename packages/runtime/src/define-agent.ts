import { assertPcm16leFormat } from "@tvic/media";
import type {
  Agent,
  AgentAudioPolicy,
  AgentId,
  AgentMemoryPolicy,
  AgentRecordingPolicy,
  AgentProviders,
  FallbackPolicy,
  InterruptionPolicy,
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

// Per-operation provider timeout. Voice-appropriate: dead air beyond this fails the
// turn rather than stranding the caller.
const DEFAULT_TIMEOUT: TimeoutPolicy = {
  timeoutMs: 10_000,
  onTimeout: "fail",
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
  readonly fallbackPolicy?: FallbackPolicy;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export function defineAgent(input: DefineAgentInput): Agent {
  // v0.1 normalized audio is pcm_s16le mono — fail fast at definition rather than
  // let a stereo/non-pcm policy reach STT/TTS and silently corrupt timing.
  assertPcm16leFormat(input.audioPolicy.input);
  assertPcm16leFormat(input.audioPolicy.output);

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
    ...(input.fallbackPolicy ? { fallbackPolicy: input.fallbackPolicy } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}
