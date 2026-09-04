import { assertPcm16leFormat } from "@tvic/media";
import type {
  Agent,
  AgentAudioPolicy,
  AgentContextPolicy,
  AgentId,
  AgentMemoryPolicy,
  AgentProviders,
  InterruptionPolicy,
  PersonaConfig,
  Provider,
  ProviderRequirements,
  TimeoutPolicy,
  ToolDefinition,
} from "@tvic/core";
import { evaluateProviderCompatibility, validationError, TvicThrowableError } from "@tvic/core";

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
  readonly contextPolicy?: AgentContextPolicy;
  readonly interruptionPolicy?: InterruptionPolicy;
  readonly timeoutPolicy?: TimeoutPolicy;
  /** Per-tenant context resolution. Optional. */
  readonly persona?: PersonaConfig;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export function defineAgent(input: DefineAgentInput): Agent {
  if (input.tools.some((tool) => tool.name === "remember_fact")) {
    throw TvicThrowableError.from(
      validationError(
        "agent.reserved_tool_name",
        "remember_fact is managed by the runtime and cannot be registered as an agent tool",
      ),
    );
  }
  // v0.1 normalized audio is pcm_s16le mono, so fail fast at definition rather than
  // let a stereo/non-pcm policy reach STT/TTS and silently corrupt timing.
  assertPcm16leFormat(input.audioPolicy.input);
  assertPcm16leFormat(input.audioPolicy.output);

  assertAgentPolicyValues(input.memoryPolicy, input.contextPolicy);

  const interruptionPolicy = input.interruptionPolicy ?? DEFAULT_INTERRUPTION;
  const requiresFunctionCalling =
    input.tools.length > 0 ||
    (input.memoryPolicy?.enabled === true &&
      input.memoryPolicy.canLlmWrite === true &&
      input.memoryPolicy.readOnly !== true);
  assertProviderSetCompatible(
    input.providers,
    input.audioPolicy,
    requiresFunctionCalling,
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
    ...(input.contextPolicy ? { contextPolicy: input.contextPolicy } : {}),
    timeoutPolicy: input.timeoutPolicy ?? DEFAULT_TIMEOUT,
    ...(input.persona ? { persona: input.persona } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}

function assertAgentPolicyValues(
  memoryPolicy: AgentMemoryPolicy | undefined,
  contextPolicy: AgentContextPolicy | undefined,
): void {
  const maxBytesPerSession = memoryPolicy?.maxBytesPerSession;
  if (
    maxBytesPerSession !== undefined &&
    (!Number.isSafeInteger(maxBytesPerSession) || maxBytesPerSession < 0)
  ) {
    throw TvicThrowableError.from(
      validationError(
        "agent.invalid_memory_policy",
        `maxBytesPerSession must be a non-negative safe integer: ${maxBytesPerSession}`,
      ),
    );
  }
  const maxHistoryBytes = contextPolicy?.maxHistoryBytes;
  if (
    maxHistoryBytes !== undefined &&
    (!Number.isSafeInteger(maxHistoryBytes) || maxHistoryBytes <= 0)
  ) {
    throw TvicThrowableError.from(
      validationError(
        "agent.invalid_context_policy",
        `maxHistoryBytes must be a positive safe integer: ${maxHistoryBytes}`,
      ),
    );
  }
  const maxHistoryMessages = contextPolicy?.maxHistoryMessages;
  if (
    maxHistoryMessages !== undefined &&
    (!Number.isSafeInteger(maxHistoryMessages) || maxHistoryMessages < 2)
  ) {
    throw TvicThrowableError.from(
      validationError(
        "agent.invalid_context_policy",
        `maxHistoryMessages must be at least 2: ${maxHistoryMessages}`,
      ),
    );
  }
  const maxPreCallBytes = contextPolicy?.maxPreCallBytes;
  if (
    maxPreCallBytes !== undefined &&
    (!Number.isSafeInteger(maxPreCallBytes) || maxPreCallBytes <= 0)
  ) {
    throw TvicThrowableError.from(
      validationError(
        "agent.invalid_context_policy",
        `maxPreCallBytes must be a positive safe integer: ${maxPreCallBytes}`,
      ),
    );
  }
  const maxPreCallEntries = contextPolicy?.maxPreCallEntries;
  if (
    maxPreCallEntries !== undefined &&
    (!Number.isSafeInteger(maxPreCallEntries) || maxPreCallEntries <= 0)
  ) {
    throw TvicThrowableError.from(
      validationError(
        "agent.invalid_context_policy",
        `maxPreCallEntries must be a positive safe integer: ${maxPreCallEntries}`,
      ),
    );
  }
}

function assertProviderSetCompatible(
  providers: AgentProviders,
  audio: AgentAudioPolicy,
  requiresFunctionCalling: boolean,
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
    functionCalling: requiresFunctionCalling,
  });
  if (providers.tts) {
    assertProviderCompatible(providers.tts, {
      kind: "tts",
      streaming: { output: true },
      ...(requiresRequestCancellation ? { cancellation: { request: true } } : {}),
      outputFormat: audio.output,
    });
  }
}

function assertProviderCompatible(provider: Provider, requirements: ProviderRequirements): void {
  const compatibility = evaluateProviderCompatibility(provider, requirements);
  if (compatibility.compatible) {
    return;
  }

  const details = compatibility.issues.map(({ code, requirement }) => `${code}:${requirement}`);
  throw TvicThrowableError.from(
    validationError(
      "agent.provider_incompatible",
      `${provider.name} is incompatible with the agent: ${details.join(", ")}`,
      {
        metadata: {
          provider: provider.name,
          kind: provider.kind,
          issues: compatibility.issues,
        },
      },
    ),
  );
}
