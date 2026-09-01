import type { AudioFormat } from "./audio.js";
import type { AgentId, OrganizationId, SessionId, UserId, WorkflowId } from "./ids.js";
import type { MemoryKind, MemoryScope } from "./memory.js";
import type { InterruptionPolicy, TimeoutPolicy } from "./policies.js";
import type {
  LLMProvider,
  SpeechToTextProvider,
  TelephonyProvider,
  TextToSpeechProvider,
} from "./providers/index.js";
import type { ToolDefinition } from "./tool.js";

export interface AgentMemoryPolicy {
  readonly enabled: boolean;
  readonly scopes: readonly MemoryScope[];
  /** Maximum cumulative UTF-8 bytes admitted to this session's memory scope. */
  readonly maxBytesPerSession?: number;
  readonly readOnly?: boolean;
  /**
   * If true (default), session-scoped memory is purged on session end. This
   * is Vapi's Zero Data Retention posture: the call's ephemeral transcripts
   * do not outlive the call. User-scoped, organization-scoped, and
   * workflow-scoped memory are *not* affected — they persist across sessions.
   *
   * Pre-1.0, this field was named `deleteOnEnd`. That name was misleading:
   * it sounded like it deleted *all* memory, but the implementation only
   * purges the `session` scope. The rename is the contract-clarity fix.
   */
  readonly deleteSessionScopeOnEnd?: boolean;
  /**
   * If true, the LLM is given a `remember_fact` tool to write to memory.
   * Default false — explicit opt-in per agent.
   */
  readonly canLlmWrite?: boolean;
  /**
   * What to load into the agent's context before a call starts.
   * - "none": do not load any memory.
   * - "all": load all enabled scopes (default).
   * - "kind:fact" / "kind:summary" / "kind:open_item" / "kind:entity_ref" / "kind:raw" / "kind:working_memory":
   *   load only entries of the given kind.
   */
  readonly preCallLoad?: "none" | "all" | `kind:${MemoryKind}`;
}

/**
 * Bounds the live prompt assembled for each LLM request. These limits apply
 * to live execution context, not recordings or durable operational evidence.
 */
export interface AgentContextPolicy {
  /** Maximum serialized UTF-8 bytes in one LLM request's messages. */
  readonly maxHistoryBytes?: number;
  /** Maximum number of messages in one LLM request, including system/current/active messages. */
  readonly maxHistoryMessages?: number;
  /** Maximum serialized UTF-8 bytes rendered from pre-call memory/static context. */
  readonly maxPreCallBytes?: number;
  /** Maximum pre-call memory entries loaded from one adapter scope. */
  readonly maxPreCallEntries?: number;
}

export interface AgentAudioPolicy {
  readonly input: AudioFormat;
  readonly output: AudioFormat;
}

export interface AgentProviders {
  readonly telephony: TelephonyProvider;
  readonly stt: SpeechToTextProvider;
  readonly llm: LLMProvider;
  readonly tts?: TextToSpeechProvider;
}

export interface PersonaConfig {
  /**
   * Per-tenant context resolution at session start. The runtime calls
   * this once when a session is attached; the result is
   * merged into the system prompt alongside the pre-call memory block.
   */
  readonly resolveTenantContext?: (input: {
    readonly sessionId: SessionId;
    readonly userId?: UserId;
    readonly organizationId?: OrganizationId;
    readonly workflowId?: WorkflowId;
  }) => Promise<{
    /** Optional override for the agent's instructions. */
    readonly instructionsOverride?: string;
    /** Optional pre-call variables, e.g. `{{customer_name}} = "Ada"`. */
    readonly variables?: ReadonlyMap<string, string>;
  }>;
  /**
   * Per-turn context resolution. The runtime calls this before each
   * turn, allowing the prompt to adapt as the call progresses (e.g.,
   * "after turn 3, soften the language"). The default behavior is to
   * call this on every turn; the user can return the same
   * `instructionsOverride` to keep the prompt stable.
   */
  readonly systemPromptForTurn?: (input: {
    readonly sessionId: SessionId;
    readonly turnNumber: number;
  }) => Promise<{ readonly instructionsOverride?: string }>;
}

export interface Agent {
  readonly id: AgentId;
  readonly name: string;
  readonly version: string;
  readonly instructions: string;
  readonly tools: readonly ToolDefinition[];
  readonly providers: AgentProviders;
  readonly audioPolicy: AgentAudioPolicy;
  readonly memoryPolicy: AgentMemoryPolicy;
  readonly interruptionPolicy: InterruptionPolicy;
  readonly contextPolicy?: AgentContextPolicy;
  /** Per-tenant context resolution. Optional. */
  readonly persona?: PersonaConfig;
  /** Per-operation timeout for provider streams (wired into the loop's stall guard). */
  readonly timeoutPolicy: TimeoutPolicy;
  readonly metadata?: Readonly<Record<string, unknown>>;
}
