import { assertPcm16leFormat } from "@tvic/media";
import type {
  Agent,
  AgentAudioPolicy,
  AgentId,
  AgentMemoryPolicy,
  AgentProviders,
  InterruptionPolicy,
  Provider,
  ProviderRequirements,
  TimeoutPolicy,
  ToolDefinition,
} from "@tvic/core";
import { evaluateProviderCompatibility, validationError } from "@tvic/core";

const DEFAULT_INTERRUPTION: InterruptionPolicy = {
  mode: "graceful",
  minSpeechMs: 200,
  trimOutputOnInterrupt: true,
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

export interface DefineAgentInput {
  readonly id: string;
  readonly name: string;
  readonly version?: string;
  readonly instructions: string;
  readonly tools: readonly ToolDefinition[];
  readonly providers: AgentProviders;
  readonly audioPolicy: AgentAudioPolicy;
  readonly memoryPolicy?: AgentMemoryPolicy;
  readonly interruptionPolicy?: InterruptionPolicy;
  readonly timeoutPolicy?: TimeoutPolicy;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export function defineAgent(input: DefineAgentInput): Agent {
  // v0.1 normalized audio is pcm_s16le mono, so fail fast at definition rather than
  // let a stereo/non-pcm policy reach STT/TTS and silently corrupt timing.
  assertPcm16leFormat(input.audioPolicy.input);
  assertPcm16leFormat(input.audioPolicy.output);

  const interruptionPolicy = input.interruptionPolicy ?? DEFAULT_INTERRUPTION;
  assertProviderSetCompatible(
    input.providers,
    input.audioPolicy,
    input.tools.length > 0,
    interruptionPolicy,
  );

  return {
    id: input.id as AgentId,
    name: input.name,
    version: input.version ?? "0.1.0",
    instructions: input.instructions,
    tools: input.tools,
    providers: input.providers,
    audioPolicy: input.audioPolicy,
    memoryPolicy: input.memoryPolicy ?? DEFAULT_MEMORY,
    interruptionPolicy,
    timeoutPolicy: input.timeoutPolicy ?? DEFAULT_TIMEOUT,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}

function assertProviderSetCompatible(
  providers: AgentProviders,
  audio: AgentAudioPolicy,
  usesTools: boolean,
  interruption: InterruptionPolicy,
): void {
  const requiresRequestCancellation = interruption.mode !== "ignore";
  const requiresBufferClearing =
    interruption.mode !== "ignore" && interruption.trimOutputOnInterrupt;

  assertProviderCompatible(providers.telephony, {
    kind: "telephony",
    streaming: { input: true, output: true },
    inputFormat: audio.input,
    outputFormat: audio.output,
    ...(requiresBufferClearing ? { playout: { clearBuffer: true } } : {}),
  });

  assertProviderCompatible(providers.stt, {
    kind: "stt",
    streaming: { input: true, output: true },
    inputFormat: audio.input,
  });
  assertProviderCompatible(providers.llm, {
    kind: "llm",
    streaming: { output: true },
    ...(requiresRequestCancellation ? { cancellation: { request: true } } : {}),
    functionCalling: usesTools,
  });
  assertProviderCompatible(providers.tts, {
    kind: "tts",
    streaming: { output: true },
    ...(requiresRequestCancellation ? { cancellation: { request: true } } : {}),
    outputFormat: audio.output,
  });
}

function assertProviderCompatible(provider: Provider, requirements: ProviderRequirements): void {
  const compatibility = evaluateProviderCompatibility(provider, requirements);
  if (compatibility.compatible) {
    return;
  }

  const details = compatibility.issues.map(({ code, requirement }) => `${code}:${requirement}`);
  throw validationError(
    "agent.provider_incompatible",
    `${provider.name} is incompatible with the agent: ${details.join(", ")}`,
    {
      metadata: {
        provider: provider.name,
        kind: provider.kind,
        issues: compatibility.issues,
      },
    },
  );
}
