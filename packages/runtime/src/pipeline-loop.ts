import {
  executeTool,
  idempotencyKeyFor,
  InMemoryToolIdempotencyStore,
  stableStringify,
  toolInputError,
} from "@tvic/tools";
import { AsyncQueue } from "@tvic/media";
import {
  BackendUnavailableError,
  cancelledError,
  createDefaultIdGenerator,
  internalError,
  normalizeUnknownError,
  timeoutError,
  validationError,
  TvicThrowableError,
} from "@tvic/core";
import type {
  ActiveSession,
  Agent,
  AgentProviders,
  CallHandle,
  IdGenerator,
  LlmInlineToolCall,
  LlmMessage,
  Memory,
  NormalizedError,
  QueuedToolCall,
  Runtime,
  SessionAttachment,
  SttStream,
  ToolCallId,
  ToolId,
  TerminalToolCall,
  TerminalTurn,
  Timestamp,
  ToolIdempotencyStore,
  Turn,
  UserId,
  OrganizationId,
  WorkflowId,
} from "@tvic/core";
import { reportAssistantText } from "./assistant-text.js";
import type { SttReconnectOptions } from "./resilient-stt.js";
import type { AssistantTextRecord } from "./assistant-text.js";
import { abortPromise, stallTimer, withTimeout } from "./async-control.js";
import { ConversationPolicy } from "./conversation-policy.js";
import { deliverAssistantText } from "./text-delivery.js";
import { withSttReconnect } from "./resilient-stt.js";
import { getSttRecoveryControl } from "./resilient-stt.js";
import { assertMemoryPolicySupported } from "./memory-capabilities.js";
import type { SttCommandController } from "./stt-command-controller.js";
import { SerialSttCommandController } from "./stt-command-controller.js";
import { PipelineSttInput } from "./pipeline-stt-input.js";
import * as pipelineConstants from "./pipeline-constants.js";
import { PipelineLlmAccumulator, REDACTED_TOOL_INPUT } from "./pipeline-llm-accumulator.js";
import { closeSttStreamBounded } from "./stt-cleanup.js";
import type { TextDeliveryMode } from "./text-delivery.js";
import { persistInterruptionCheckpoint } from "./persistence-policy.js";
import {
  cancellationReason,
  awaitTerminalTurn,
  closeAsyncIterator,
  isTerminalToolCall,
  linkAbortSignal,
  raceStartup,
  readTerminalTurn,
} from "./pipeline-helpers.js";
import { alignedTextForHistory } from "./turn-alignment.js";
import { reportTurnLatency } from "./turn-state.js";
import { recordTerminalTurn } from "./pipeline-turn-observation.js";
import { PipelineMemoryCoordinator } from "./pipeline-memory.js";
import { resolveTurnSystemPrompt } from "./pipeline-persona.js";
import {
  createPipelineIncrementalTtsInput,
  createPipelineTtsPlayer,
  speakPipelineTts,
} from "./pipeline-loop-tts.js";
import { DualProtocolResultImpl } from "./dual-protocol-result.js";
import { PipelineVoiceLoopBuilder } from "./pipeline-loop-builder.js";
import type { DualProtocolResult, VoiceEvent } from "./voice-event.js";
import {
  attachmentAbortReason,
  drainAsyncIterator,
  finishToolCall,
  metadataString,
  recordToolCall,
  startToolCall,
} from "./pipeline-loop-boundary.js";
import { PipelineTerminalCoordinator } from "./pipeline-terminal-boundary.js";
import type { LiveTerminalSource } from "./terminal-arbitration.js";
import type {
  ActiveTurnControl,
  MutableTurnLatency,
  TurnLatencyRecord,
  UtteranceTiming,
} from "./turn-state.js";
function serializableToolValue(value: unknown): unknown {
  try {
    stableStringify(value);
    return value;
  } catch {
    return REDACTED_TOOL_INPUT;
  }
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return JSON.stringify(REDACTED_TOOL_INPUT);
  }
}

async function cancelLlmCompletion(completion: { cancel(): Promise<void> }): Promise<void> {
  await withTimeout(
    completion.cancel(),
    pipelineConstants.PROVIDER_CANCEL_TIMEOUT_MS,
    timeoutError(
      "llm.cancel_timeout",
      `LLM cancellation timed out after ${pipelineConstants.PROVIDER_CANCEL_TIMEOUT_MS}ms`,
      { retriable: false },
    ),
  ).catch(() => undefined);
}
export type { TurnLatencyRecord } from "./turn-state.js";
export interface PipelineVoiceLoopOptions {
  readonly runtime: Runtime;
  readonly session: ActiveSession;
  readonly attachment?: SessionAttachment;
  readonly agent: Agent;
  readonly callHandle: CallHandle;
  readonly llmModel: string;
  readonly sttModel?: string;
  /** Allows a custom/self-hosted STT endpoint to accept a model outside TVIC's dated catalog. */
  readonly sttAllowUnknownModel?: boolean;
  readonly sttReconnect?: boolean | SttReconnectOptions;
  readonly sttLanguage?: string;
  readonly ttsVoice?: string;
  readonly ttsModel?: string;
  readonly idGenerator?: IdGenerator;
  readonly conversationPolicy?: ConversationPolicy;
  readonly memory?: Memory;
  readonly memoryUserId?: UserId;
  readonly organizationId?: import("@tvic/core").OrganizationId;
  readonly workflowId?: import("@tvic/core").WorkflowId;
  readonly preCallContext?: import("@tvic/core").PreCallContext;
  readonly safetyIdentifier?: string;
  readonly textDelivery?: TextDeliveryMode;
  /** Max ms a provider stream may stall (no events) before the turn fails. */
  readonly streamStallTimeoutMs?: number;
  /** Inactivity debounce after the latest immutable final segment. */
  readonly turnEndpointTimeoutMs?: number;
  /** Absolute cap from the first immutable final segment in one utterance. */
  readonly turnMaxDurationMs?: number;
  /** Optional managed-owner source for an external cancellation signal. */
  readonly terminalSourceForCancellation?: () => LiveTerminalSource | undefined;
  /**
   * Receives one record per terminal turn. This is an observation seam, not part of
   * execution: it is invoked after the turn is already terminal, its return value is
   * ignored, and a throw from it is swallowed so an observer can never affect a call.
   */
  readonly onTurnLatency?: (record: TurnLatencyRecord) => void;
  readonly onAssistantText?: (record: AssistantTextRecord) => void;
  readonly sessionMetricsRecorder?: import("@tvic/core").SessionMetricsRecorder;
}

export interface PipelineVoiceLoopResult {
  readonly session: ActiveSession;
  readonly turnsHandled: number;
  readonly interruptions: number;
  readonly turnsFailed: number;
  readonly firstTurnError: NormalizedError | null;
  readonly terminalReason: "completed" | "cancelled" | "remote_hangup" | "failed";
  readonly terminalSource: LiveTerminalSource;
}

/**
 * Runs a pipeline voice session: media -> STT -> LLM/tools -> TTS -> media.
 * This module owns only live execution and failure handling; telemetry belongs
 * outside the runtime's critical path.
 */
export class PipelineVoiceLoop {
  readonly #options: PipelineVoiceLoopOptions;
  readonly #providers: AgentProviders;
  readonly #ids: IdGenerator;
  readonly #policy: ConversationPolicy;
  readonly #idempotency: ToolIdempotencyStore;
  readonly #memoryCoordinator: PipelineMemoryCoordinator;
  readonly #stallTimeoutMs: number;
  readonly #turnEndpointTimeoutMs: number;
  readonly #turnMaxDurationMs: number;
  readonly #onTimeout: "fail" | "interrupt";
  #turnsHandled = 0;
  #turnsFailed = 0;
  #firstTurnError: NormalizedError | null = null;
  #interruptions = 0;
  #turnChain: Promise<void> = Promise.resolve();
  #active: ActiveTurnControl | null = null;
  #shutdownReason: string | null = null;
  #removeRecoveryListener: (() => void) | undefined;
  readonly #sttInput: PipelineSttInput;
  #persistenceDegraded = false;
  #persistenceGate: Promise<boolean> = Promise.resolve(true);
  readonly #memoryUserId: UserId | undefined;
  readonly #organizationId: OrganizationId | undefined;
  readonly #workflowId: WorkflowId | undefined;
  readonly #memory: Memory | undefined;
  readonly #terminal: PipelineTerminalCoordinator;
  readonly #recordTerminalTurn: (turn: TerminalTurn) => void;
  constructor(options: PipelineVoiceLoopOptions) {
    this.#options = options;
    this.#providers = options.agent.providers;
    this.#ids = options.idGenerator ?? createDefaultIdGenerator();
    const metadata = options.session.metadata ?? options.attachment?.session.metadata;
    this.#memoryUserId =
      options.memoryUserId ?? (metadataString(metadata, "memoryUserId") as UserId | undefined);
    this.#organizationId =
      options.organizationId ??
      (metadataString(metadata, "organizationId") as OrganizationId | undefined);
    this.#workflowId =
      options.workflowId ?? (metadataString(metadata, "workflowId") as WorkflowId | undefined);
    const runtimeMemory = options.runtime.memory;
    if (options.memory && runtimeMemory && options.memory !== runtimeMemory) {
      throw TvicThrowableError.from(
        validationError(
          "memory.adapter_mismatch",
          "PipelineVoiceLoop received a memory adapter different from the runtime adapter",
        ),
      );
    }
    this.#memory = options.memory ?? runtimeMemory;
    if (this.#memory) {
      assertMemoryPolicySupported(this.#memory, options.agent.memoryPolicy);
    }
    this.#memoryCoordinator = new PipelineMemoryCoordinator({
      runtime: options.runtime,
      sessionId: options.session.id,
      agent: options.agent,
      ...(options.attachment ? { attachment: options.attachment } : {}),
      ...(this.#memory ? { memory: this.#memory } : {}),
      ...(this.#memoryUserId ? { memoryUserId: this.#memoryUserId } : {}),
      ...(this.#organizationId ? { organizationId: this.#organizationId } : {}),
      ...(this.#workflowId ? { workflowId: this.#workflowId } : {}),
    });
    const preCallContext: import("@tvic/core").PreCallContext | undefined =
      options.preCallContext ?? options.attachment?.preCallContext;
    this.#policy =
      options.conversationPolicy ??
      new ConversationPolicy({
        agent: options.agent,
        ...(preCallContext ? { preCallContext } : {}),
      });
    if (options.attachment) {
      this.#policy.hydrateTurns(options.attachment.snapshot.turns);
    }
    this.#stallTimeoutMs = options.streamStallTimeoutMs ?? options.agent.timeoutPolicy.timeoutMs;
    this.#turnEndpointTimeoutMs =
      options.turnEndpointTimeoutMs ?? pipelineConstants.DEFAULT_TURN_ENDPOINT_TIMEOUT_MS;
    this.#turnMaxDurationMs =
      options.turnMaxDurationMs ?? pipelineConstants.DEFAULT_TURN_MAX_DURATION_MS;
    this.#onTimeout = options.agent.timeoutPolicy.onTimeout;
    this.#idempotency = options.runtime.toolIdempotencyStore ?? new InMemoryToolIdempotencyStore();
    this.#terminal = new PipelineTerminalCoordinator({
      ...(options.attachment?.signal ? { attachmentSignal: options.attachment.signal } : {}),
      ...(options.terminalSourceForCancellation
        ? { sourceForCancellation: options.terminalSourceForCancellation }
        : {}),
    });
    this.#recordTerminalTurn = (turn) =>
      recordTerminalTurn(turn, this.#options.session.id, this.#options.sessionMetricsRecorder);
    this.#sttInput = new PipelineSttInput({
      callHandle: options.callHandle,
      policy: this.#policy,
      interruptionPolicy: options.agent.interruptionPolicy,
      endpointTimeoutMs: this.#turnEndpointTimeoutMs,
      maxDurationMs: this.#turnMaxDurationMs,
      now: () => this.#monotonicMs(),
      getActive: () => this.#active,
      onTranscript: (transcript, timing) => {
        this.#turnChain = this.#turnChain.then(() => this.#handleTranscript(transcript, timing));
      },
      interrupt: (cause) => this.#interrupt(cause),
    });
  }

  #effectiveSignal(): AbortSignal | undefined {
    const attachment = this.#options.attachment?.signal;
    const override = this.#runOverrideSignal;
    if (override && attachment) {
      return AbortSignal.any([override, attachment]);
    }
    return override ?? attachment;
  }

  #runOverrideSignal: AbortSignal | undefined;
  #runEvents: AsyncQueue<VoiceEvent> | undefined;
  #runInternalEvents: AsyncQueue<VoiceEvent> | undefined;
  #runConsumer: "internal" | "public" = "internal";
  #runSupervisor: AbortController | undefined;
  #runStarted = false;
  #runCancelled = false;
  #runEndReason: string | undefined;
  #runEventError: unknown;
  #removeRunAbortListener: (() => void) | undefined;
  /** Start a call and expose an awaitable, iterable result. */
  start(options: { readonly overrideSignal?: AbortSignal } = {}): PipelineVoiceLoopBuilder {
    return new PipelineVoiceLoopBuilder(this, options.overrideSignal);
  }

  /**
   * Legacy: returns `Promise<PipelineVoiceLoopResult>`. Equivalent to
   * `await this.start(options)`. Convenience wrapper preserved for backward
   * compatibility with the v0.0.x API.
   */
  async run(
    options: { readonly overrideSignal?: AbortSignal } = {},
  ): Promise<PipelineVoiceLoopResult> {
    const result = this.start(options);
    return await result;
  }

  /**
   * Implementation hook for {@link PipelineVoiceLoopBuilder}. Returns a
   * `DualProtocolResult` that wraps the run promise and event queue.
   */
  _startInternal(options: {
    readonly overrideSignal?: AbortSignal;
    readonly consumer?: "internal" | "public";
    /** Internal lifecycle hook used by managed wrappers without thenable assimilation. */
    readonly onRunPromise?: (promise: Promise<PipelineVoiceLoopResult>) => void;
  }): DualProtocolResult {
    if (this.#runStarted) {
      const error = new Error("PipelineVoiceLoop can only be started once");
      const runPromise = Promise.reject<PipelineVoiceLoopResult>(error);
      options.onRunPromise?.(runPromise);
      void runPromise.catch(() => undefined);
      const events = new AsyncQueue<VoiceEvent>({ maxBuffered: 1024 });
      events.close();
      return new DualProtocolResultImpl({
        runPromise,
        events,
        cancel: () => undefined,
        sessionId: this.#options.session.id,
      });
    }
    this.#runStarted = true;
    this.#runConsumer = options.consumer ?? "internal";
    this.#runOverrideSignal = options.overrideSignal;
    const events = new AsyncQueue<VoiceEvent>({ maxBuffered: 1024 });
    this.#runEvents = events;
    const internalEvents =
      this.#runConsumer === "internal"
        ? new AsyncQueue<VoiceEvent>({ maxBuffered: 1024 })
        : undefined;
    this.#runInternalEvents = internalEvents;
    this.#runCancelled = false;
    this.#runEndReason = undefined;
    this.#runEventError = undefined;
    this.#removeRunAbortListener?.();
    this.#removeRunAbortListener = undefined;
    const runSignal = this.#effectiveSignal();
    this.#removeRunAbortListener = this.#terminal.watchSignal(runSignal, () => {
      this.#runCancelled = true;
      this.#terminal.offerTerminal({
        source: this.#terminal.cancellationSource(),
      });
    });
    let resolveRun!: (result: PipelineVoiceLoopResult) => void;
    let rejectRun!: (reason: unknown) => void;
    const runPromise = new Promise<PipelineVoiceLoopResult>((resolve, reject) => {
      resolveRun = resolve;
      rejectRun = reject;
    });
    options.onRunPromise?.(runPromise);
    void runPromise.catch(() => undefined);
    const cancel = (): void => {
      if (this.#runCancelled) return;
      this.#runCancelled = true;
      this.#terminal.offerTerminal({
        source: this.#terminal.cancellationSource(),
      });
      this.#runSupervisor?.abort();
    };
    if (internalEvents) {
      const iterator = internalEvents[Symbol.asyncIterator]();
      void drainAsyncIterator(iterator, (error) => {
        this.#runEventError ??= error;
        this.#runCancelled = true;
        this.#runSupervisor?.abort(error);
      });
    }
    const result = new DualProtocolResultImpl({
      runPromise,
      events,
      cancel,
      sessionId: this.#options.session.id,
    });
    const unregisterRuntimeRun = this.#options.runtime.registerPipelineRun?.(runPromise, cancel);
    if (unregisterRuntimeRun) {
      void runPromise.then(unregisterRuntimeRun, unregisterRuntimeRun);
    }
    void this.#runBody(events, resolveRun, rejectRun).catch(() => {
      /* the body's catch in #runBody resolves/rejects runPromise */
    });
    return result;
  }

  #emitVoiceEvent(event: VoiceEvent): void {
    const events = this.#runEvents;
    if (!events || this.#runEventError) return;
    const internalEvents = this.#runInternalEvents;
    const publicAccepted = events.push(event) || events.isClosed;
    const internalAccepted = internalEvents
      ? internalEvents.push(event) || internalEvents.isClosed
      : true;
    if (publicAccepted && internalAccepted) return;
    const error = TvicThrowableError.from(
      internalError("voice_runtime.events_overflow", "Voice event buffer capacity was exceeded"),
    );
    this.#runEventError = error;
    events.fail(error);
    internalEvents?.fail(error);
    this.#runCancelled = true;
    this.#runSupervisor?.abort(error);
  }

  async #runBody(
    events: AsyncQueue<VoiceEvent>,
    resolveRun: (result: PipelineVoiceLoopResult) => void,
    rejectRun: (reason: unknown) => void,
  ): Promise<void> {
    try {
      const result = await this.#runLegacy(events);
      if (this.#runEventError) {
        events.fail(this.#runEventError);
        this.#runInternalEvents?.fail(this.#runEventError);
        rejectRun(this.#runEventError);
        return;
      }
      const claim = await this.#terminal.committedTerminal(
        this.#terminal.candidateForResult(result, this.#runEndReason ?? "completed"),
      );
      this.#emitVoiceEvent({
        kind: "call_ended",
        reason: claim.kind,
        totalTurns: result.turnsHandled,
      });
      if (this.#runEventError) {
        this.#runInternalEvents?.fail(this.#runEventError);
        rejectRun(this.#runEventError);
        return;
      }
      events.close();
      this.#runInternalEvents?.close();
      resolveRun({
        ...result,
        terminalReason: claim.kind,
        terminalSource: claim.source,
      });
      return;
    } catch (err) {
      const normalized = normalizeUnknownError(err, {
        code: "turn.failed",
        category: "internal",
        retriable: false,
      });
      const claim = await this.#terminal.committedTerminal(
        this.#terminal.candidateForError(
          normalized,
          this.#runCancelled,
          this.#effectiveSignal()?.aborted ?? false,
        ),
      );
      const cancelled = claim.kind === "cancelled" || claim.kind === "remote_hangup";
      this.#emitVoiceEvent({
        kind: "error",
        error: normalized,
        recoverable: !cancelled && normalized.retriable,
      });
      this.#emitVoiceEvent({
        kind: "call_ended",
        reason: claim.kind,
        totalTurns: this.#turnsHandled,
      });
      if (!this.#runEventError) {
        events.close();
        this.#runInternalEvents?.close();
      } else {
        this.#runInternalEvents?.fail(this.#runEventError);
      }
      // Never let a raw provider/transport exception cross the public result
      // boundary. Normalized errors are already safe to expose and are kept by
      // reference for callers that use them as provider sentinels.
      rejectRun(this.#runEventError ?? normalized);
    } finally {
      this.#removeRunAbortListener?.();
      this.#removeRunAbortListener = undefined;
      this.#runOverrideSignal = undefined;
      this.#runSupervisor = undefined;
      this.#runEvents = undefined;
      this.#runInternalEvents = undefined;
    }
  }

  async #runLegacy(_events: AsyncQueue<VoiceEvent>): Promise<PipelineVoiceLoopResult> {
    const startupAbort = new AbortController();
    this.#runSupervisor = startupAbort;
    const detachStartupSignal = linkAbortSignal(this.#effectiveSignal(), startupAbort);
    const sttProvider = this.#options.sttReconnect
      ? withSttReconnect(
          this.#providers.stt,
          typeof this.#options.sttReconnect === "boolean" ? {} : this.#options.sttReconnect,
        )
      : this.#providers.stt;
    let stt: SttStream;
    let opening: Promise<SttStream> | undefined;

    // Resolve per-session persona context at startup. Best-effort: if the
    // resolver throws or the timeout hits, fall back to agent.instructions.
    // The persona's `instructionsOverride` becomes the system prompt; the
    // per-turn `systemPromptForTurn` (when defined) can adapt further.
    const persona = this.#options.agent.persona;
    if (persona?.resolveTenantContext) {
      try {
        const result = await withTimeout(
          persona.resolveTenantContext({
            sessionId: this.#options.session.id,
            ...(this.#memoryUserId ? { userId: this.#memoryUserId } : {}),
            ...(this.#organizationId ? { organizationId: this.#organizationId } : {}),
            ...(this.#workflowId ? { workflowId: this.#workflowId } : {}),
          }),
          1_000,
        );
        if (result.instructionsOverride !== undefined) {
          this.#policy.replaceSystemInstruction(result.instructionsOverride);
        }
        if (result.variables) {
          this.#policy.setStaticVariables(result.variables);
        }
      } catch {
        // Swallow: persona resolution failure must not block the call.
      }
    }
    try {
      opening = sttProvider.open({
        sessionId: this.#options.session.id,
        format: this.#options.agent.audioPolicy.input,
        ...(this.#options.sttModel !== undefined ? { model: this.#options.sttModel } : {}),
        ...(this.#options.sttAllowUnknownModel ? { allowUnknownModel: true } : {}),
        ...(this.#options.sttLanguage ? { language: this.#options.sttLanguage } : {}),
        interimResults: true,
        vocabulary: this.#options.agent.tools.map((tool) => String(tool.name)),
        ...(this.#options.agent.metadata ? { metadata: this.#options.agent.metadata } : {}),
        signal: startupAbort.signal,
      });
      opening.catch(() => undefined);
      stt = await withTimeout(
        opening,
        pipelineConstants.STARTUP_TIMEOUT_MS,
        timeoutError(
          "stt.open_timeout",
          `STT open timed out after ${pipelineConstants.STARTUP_TIMEOUT_MS}ms`,
        ),
        startupAbort.signal,
        cancelledError("stt.open_cancelled", "STT session startup was cancelled"),
      );
    } catch (error) {
      startupAbort.abort();
      if (opening) {
        void opening.then(closeSttStreamBounded).catch(() => undefined);
      }
      throw TvicThrowableError.from(
        normalizeUnknownError(error, {
          code: "stt.open_failed",
          category: "internal",
          retriable: false,
        }),
      );
    } finally {
      detachStartupSignal();
    }

    const recovery = getSttRecoveryControl(stt);
    const commandController: SttCommandController =
      recovery?.controller ??
      new SerialSttCommandController({
        stream: stt,
      });
    this.#removeRecoveryListener = recovery?.subscribe((state) =>
      this.#sttInput.setRecoveryState(state),
    );
    if (recovery) {
      this.#sttInput.setRecoveryState(recovery.state());
    }

    const supervisor = new AbortController();
    this.#runSupervisor = supervisor;
    const detachSupervisorSignal = linkAbortSignal(this.#effectiveSignal(), supervisor);
    let sttError: unknown = null;
    let transcriptError: unknown = null;
    let shutdownError: unknown = null;
    let sttEnded = false;
    commandController.failure.catch((error) => {
      const failure = normalizeUnknownError(error, {
        code: "stt.command_failed",
        category: "internal",
        retriable: false,
      });
      sttError ??= failure;
      this.#terminal.offerTerminal({
        source: "provider_runtime",
        error: failure,
      });
      supervisor.abort();
      void this.#options.callHandle.close("error").catch(() => undefined);
    });
    const transcriptTask = this.#sttInput.consumeTranscripts(stt.events);
    transcriptTask.then(
      () => {
        sttEnded = true;
        supervisor.abort();
      },
      (error) => {
        sttError = error;
        this.#terminal.offerTerminal({
          source: "provider_runtime",
          error: normalizeUnknownError(error, {
            code: "stt.failed",
            category: "internal",
            retriable: false,
          }),
        });
        sttEnded = true;
        supervisor.abort();
      },
    );

    let endReason = "remote_hangup";
    let streamError: NormalizedError | null = null;
    let mediaEnded = false;
    try {
      const input = await this.#sttInput.consumeInput(stt, commandController, supervisor.signal);
      endReason = input.endReason;
      this.#runEndReason = endReason;
      streamError = input.streamError;
      mediaEnded = input.mediaEnded;
      const source = this.#terminal.sourceForEndReason(endReason, streamError);
      if (source !== "normal_completion") {
        this.#terminal.offerTerminal({
          source,
          ...(streamError ? { error: streamError } : {}),
        });
      }
    } catch (error) {
      endReason = "media_error";
      streamError = normalizeUnknownError(error, {
        code: "media.input_failed",
        category: "internal",
        retriable: false,
      });
      mediaEnded = true;
      this.#terminal.offerTerminal({
        source: "provider_runtime",
        error: streamError,
      });
    }

    this.#shutdownReason =
      attachmentAbortReason(this.#options.attachment?.signal) ??
      (this.#runCancelled || this.#effectiveSignal()?.aborted
        ? "explicit"
        : sttError
          ? "stt_error"
          : sttEnded
            ? "stt_ended"
            : endReason);

    const gracefulEnd = mediaEnded && endReason === "completed" && !sttError;
    if (gracefulEnd && !sttEnded) {
      const terminalFlush = this.#sttInput.commitAndFlush(stt, commandController);
      this.#sttInput.pendingCommitFlushes.add(terminalFlush);
      void terminalFlush
        .finally(() => this.#sttInput.pendingCommitFlushes.delete(terminalFlush))
        .catch(() => undefined);
      try {
        await withTimeout(
          Promise.allSettled(this.#sttInput.pendingCommitFlushes),
          pipelineConstants.STT_CLOSE_TIMEOUT_MS,
          timeoutError(
            "stt.commit_drain_timeout",
            `STT commit drain timed out after ${pipelineConstants.STT_CLOSE_TIMEOUT_MS}ms`,
            { retriable: false },
          ),
        );
      } catch (error) {
        shutdownError ??= error;
      }
      await withTimeout(commandController.drain(), pipelineConstants.STT_CLOSE_TIMEOUT_MS).catch(
        () => undefined,
      );
    } else {
      // Caller/media shutdown preempts commit grace before stream close; otherwise
      // a late promise could flush a new turn after hangup.
      supervisor.abort(sttError ?? new Error("STT input ended"));
      await withTimeout(
        commandController.abort(sttError ?? new Error("STT input ended")),
        pipelineConstants.STT_CLOSE_TIMEOUT_MS,
      ).catch(() => undefined);
    }

    this.#abortActive(this.#shutdownReason ?? "explicit");
    this.#sttInput.cancelBargeInCandidate();
    await closeSttStreamBounded(stt).catch(() => undefined);
    this.#removeRecoveryListener?.();
    this.#removeRecoveryListener = undefined;
    detachSupervisorSignal();
    try {
      await withTimeout(
        transcriptTask,
        pipelineConstants.STT_CLOSE_TIMEOUT_MS,
        timeoutError(
          "stt.transcript_drain_timeout",
          `STT transcript drain timed out after ${pipelineConstants.STT_CLOSE_TIMEOUT_MS}ms`,
          { retriable: false },
        ),
      );
    } catch (error) {
      transcriptError = error;
      sttError ??= error;
      shutdownError ??= error;
    }
    try {
      await withTimeout(
        this.#turnChain,
        pipelineConstants.STT_CLOSE_TIMEOUT_MS,
        timeoutError(
          "turn.drain_timeout",
          `Turn drain timed out after ${pipelineConstants.STT_CLOSE_TIMEOUT_MS}ms`,
          { retriable: false },
        ),
      );
    } catch (error) {
      shutdownError ??= error;
    }

    if (streamError) {
      throw TvicThrowableError.from(streamError);
    }
    if (transcriptError) {
      throw transcriptError;
    }
    if (sttError) {
      throw TvicThrowableError.from(
        normalizeUnknownError(sttError, {
          code: "stt.failed",
          category: "internal",
          retriable: false,
        }),
      );
    }
    if (shutdownError) {
      throw TvicThrowableError.from(
        normalizeUnknownError(shutdownError, {
          code: "stt.shutdown_failed",
          category: "internal",
          retriable: false,
        }),
      );
    }
    if (!mediaEnded) {
      if (this.#runCancelled || this.#effectiveSignal()?.aborted) {
        throw TvicThrowableError.from(
          cancelledError("call.cancelled", "The voice pipeline was cancelled"),
        );
      }
      this.#terminal.offerTerminal({
        source: "provider_runtime",
        error: internalError(
          "stt.closed_unexpectedly",
          "STT stream ended before the caller's media did",
        ),
      });
      throw TvicThrowableError.from(
        internalError("stt.closed_unexpectedly", "STT stream ended before the caller's media did"),
      );
    }
    return {
      session: this.#options.session,
      turnsHandled: this.#turnsHandled,
      interruptions: this.#interruptions,
      turnsFailed: this.#turnsFailed,
      firstTurnError: this.#firstTurnError,
      terminalReason: "completed",
      terminalSource: "normal_completion",
    };
  }

  #abortActive(reason: string): void {
    const control = this.#active;
    if (control && control.interruptedAtMs === null && !control.outputDelivered) {
      control.interruptedAtMs = this.#monotonicMs();
      control.cancelReason = cancellationReason(reason);
      control.abort.abort();
    }
  }

  #markPersistenceDegraded(): void {
    this.#persistenceDegraded = true;
    this.#options.runtime.setPersistenceHealth(this.#options.session.id, true);
    this.#active?.abort.abort();
  }

  async #persistTurnStatus(
    turnId: Turn["id"],
    status: "thinking" | "calling_tool" | "speaking",
  ): Promise<void> {
    try {
      await this.#options.runtime.updateTurnStatus(this.#options.session.id, turnId, status);
    } catch (error) {
      this.#markPersistenceDegraded();
      throw error;
    }
  }

  async #handleTranscript(transcript: string, timing: UtteranceTiming): Promise<void> {
    if (this.#persistenceDegraded || !(await this.#persistenceGate)) return;
    let turn: Turn;
    try {
      turn = await this.#options.runtime.startTurn({
        sessionId: this.#options.session.id,
        input: { transcript, mediaEventIds: [] },
      });
      await this.#persistTurnStatus(turn.id, "thinking");
    } catch (error) {
      this.#markPersistenceDegraded();
      const failure = normalizeUnknownError(error, {
        code: "turn.persistence_failed",
        category: "internal",
        retriable: false,
      });
      this.#turnsFailed += 1;
      this.#firstTurnError ??= failure;
      await this.#options.runtime
        .endSession(this.#options.session.id, { reason: "failed", error: failure })
        .catch(() => undefined);
      this.#emitVoiceEvent({
        kind: "error",
        error: failure,
        recoverable: failure.retriable,
      });
      return;
    }
    this.#turnsHandled += 1;

    // Anchor every stage measurement at the endpoint commit, not at turn setup: the
    // caller starts waiting when they stop talking, not when the promise chain gets here.
    const startedAtMs = timing.endpointAtMs;
    const control: ActiveTurnControl = {
      turnId: turn.id,
      abort: new AbortController(),
      startedAtMs,
      interruptedAtMs: null,
      interruptionTailMs: null,
      cancelReason: "barge_in",
      outputFramesSent: 0,
      speaking: false,
      outputDelivered: false,
      alignedTokens: [],
      alignedTokenBytes: 0,
      alignedUnit: null,
      alignedCharacterStarts: new Set(),
      alignedDurationMs: 0,
      lastFlushSequence: null,
    };
    this.#emitVoiceEvent({
      kind: "turn_started",
      turnId: turn.id,
      turnSequence: turn.sequence,
    });
    this.#emitVoiceEvent({
      kind: "transcript_delta",
      text: transcript,
      turnId: turn.id,
      isFinal: true,
    });
    let terminalWriteMayBeLate = false;
    const detachControlSignal = linkAbortSignal(this.#effectiveSignal(), control.abort);
    const detachAttachmentClear = this.#options.attachment?.signal
      ? (() => {
          const clear = () => {
            void withTimeout(
              this.#options.callHandle.clear(),
              pipelineConstants.CLEAR_TIMEOUT_MS,
            ).catch(() => undefined);
          };
          this.#options.attachment.signal.addEventListener("abort", clear, { once: true });
          return () => this.#options.attachment?.signal?.removeEventListener("abort", clear);
        })()
      : () => undefined;
    this.#active = control;
    if (this.#shutdownReason || this.#options.attachment?.signal.aborted) {
      control.interruptedAtMs = this.#monotonicMs();
      control.cancelReason = cancellationReason(
        this.#shutdownReason ??
          attachmentAbortReason(this.#options.attachment?.signal) ??
          "transport_lost",
      );
      control.abort.abort();
    }
    const latency: MutableTurnLatency = {
      ...(timing.listenedMs !== undefined ? { listenedMs: timing.listenedMs } : {}),
      ...(timing.endpointMs !== undefined ? { endpointMs: timing.endpointMs } : {}),
    };
    let turnCompletedEmitted = false;
    const emitTurnCompleted = (status: TerminalTurn["status"]): void => {
      if (turnCompletedEmitted) return;
      turnCompletedEmitted = true;
      this.#emitVoiceEvent({
        kind: "turn_completed",
        turnId: turn.id,
        status,
        latencyMs: latency.totalMs ?? this.#durationSince(startedAtMs),
      });
    };
    let finalText = "";
    let audioError: NormalizedError | null = null;
    let textDelivered: boolean | undefined;
    let incrementalFailure: unknown = null;
    let speakingPersisted = false;
    const toolCallIds: ToolCallId[] = [];
    const playTtsStream = createPipelineTtsPlayer({
      callHandle: this.#options.callHandle,
      stallTimeoutMs: this.#stallTimeoutMs,
      onTimeout: this.#onTimeout,
      monotonicMs: () => this.#monotonicMs(),
      abortActive: (reason) => this.#abortActive(reason),
      emitVoiceEvent: (event) => this.#emitVoiceEvent(event),
    });
    const incrementalInput = createPipelineIncrementalTtsInput({
      provider: this.#providers.tts,
      sessionId: this.#options.session.id,
      turn,
      format: this.#options.agent.audioPolicy.output,
      ...(this.#options.ttsVoice ? { voice: this.#options.ttsVoice } : {}),
      ...(this.#options.ttsModel ? { model: this.#options.ttsModel } : {}),
      signal: control.abort.signal,
    });
    const incrementalPlayback = incrementalInput
      ? incrementalInput.opened
          .then(async (opened) => {
            if (!opened) {
              // `opened === false` means finish/cancellation completed before a
              // provider session was needed; no participant-visible audio exists.
              control.outputDelivered = false;
              return;
            }
            await playTtsStream(incrementalInput, control, latency);
          })
          .catch((error: unknown) => {
            incrementalFailure ??= error;
          })
      : null;
    incrementalPlayback?.catch(() => undefined);
    const onLlmText = incrementalInput
      ? async (text: string): Promise<void> => {
          if (incrementalFailure || control.abort.signal.aborted) return;
          if (!speakingPersisted) {
            await this.#persistTurnStatus(turn.id, "speaking");
            speakingPersisted = true;
          }
          await withTimeout(
            incrementalInput.pushToken(text),
            this.#stallTimeoutMs,
            timeoutError(
              "tts.input_timeout",
              `Incremental TTS input timed out after ${this.#stallTimeoutMs}ms`,
              { retriable: false },
            ),
          ).catch((error: unknown) => {
            incrementalFailure ??= error;
          });
        }
      : undefined;

    try {
      await resolveTurnSystemPrompt(
        this.#options.agent.persona?.systemPromptForTurn,
        this.#options.session.id,
        turn.sequence,
        (instructions) => this.#policy.setTurnSystemInstruction(instructions),
      );
      const messages = this.#policy.messagesForTranscript(transcript);
      const first = await this.#runLlm(turn, messages, control, latency, onLlmText);
      finalText = first.text;

      if (!control.abort.signal.aborted && first.toolCalls.length > 0) {
        if (incrementalInput && !incrementalFailure) {
          await withTimeout(
            incrementalInput.flushBoundary(),
            this.#stallTimeoutMs,
            timeoutError(
              "tts.flush_timeout",
              `Incremental TTS flush timed out after ${this.#stallTimeoutMs}ms`,
              { retriable: false },
            ),
          ).catch((error: unknown) => {
            incrementalFailure ??= error;
          });
        }
        await this.#persistTurnStatus(turn.id, "calling_tool");
        const tools = await this.#executeToolCalls(turn, first.toolCalls, control, latency);
        toolCallIds.push(...tools.toolCallIds);
        if (!control.abort.signal.aborted) {
          const continuation = await this.#runLlm(
            turn,
            this.#policy.messagesForToolContinuation(
              messages,
              first.text,
              tools.messages,
              tools.assistantToolCalls,
            ),
            control,
            latency,
            onLlmText,
          );
          finalText = continuation.text;
        }
      }

      let audioDelivered = false;
      try {
        if (!control.abort.signal.aborted) {
          if (incrementalInput) {
            if (!speakingPersisted) {
              await this.#persistTurnStatus(turn.id, "speaking");
              speakingPersisted = true;
            }
            if (incrementalFailure) throw incrementalFailure;
            await withTimeout(
              incrementalInput.finish(),
              this.#stallTimeoutMs,
              timeoutError(
                "tts.finish_timeout",
                `Incremental TTS finish timed out after ${this.#stallTimeoutMs}ms`,
                { retriable: false },
              ),
            );
            await incrementalPlayback;
            if (incrementalFailure) throw incrementalFailure;
          } else if (this.#providers.tts) {
            await this.#persistTurnStatus(turn.id, "speaking");
            await speakPipelineTts(this.#providers.tts, {
              sessionId: this.#options.session.id,
              turn,
              text: finalText,
              format: this.#options.agent.audioPolicy.output,
              ...(this.#options.ttsVoice ? { voice: this.#options.ttsVoice } : {}),
              ...(this.#options.ttsModel ? { model: this.#options.ttsModel } : {}),
              signal: control.abort.signal,
              control,
              latency,
              play: playTtsStream,
            });
          }
          audioDelivered = control.outputDelivered;
        } else if (incrementalInput) {
          await incrementalInput.cancel();
          await incrementalPlayback?.catch(() => undefined);
        }
      } catch (error) {
        audioError = normalizeUnknownError(error, {
          code: "tts.delivery_failed",
          category: "internal",
          retriable: false,
        });
        this.#abortActive("tts_failed");
      }

      const cancelledByBargeIn =
        control.interruptedAtMs !== null && control.cancelReason === "barge_in";
      textDelivered =
        !control.abort.signal.aborted || cancelledByBargeIn || audioError !== null
          ? await deliverAssistantText({
              callHandle: this.#options.callHandle,
              turn,
              text: finalText,
              ...(this.#options.textDelivery ? { mode: this.#options.textDelivery } : {}),
              audioDelivered,
              cancelledByBargeIn,
            })
          : false;
      control.outputDelivered = audioDelivered || textDelivered === true;
      latency.totalMs = this.#durationSince(startedAtMs);

      if (!control.outputDelivered) {
        if (control.interruptionTailMs !== null) {
          latency.interruptionTailMs = control.interruptionTailMs;
        }
        let terminal: TerminalTurn;
        try {
          terminal = await this.#options.runtime.endTurn(this.#options.session.id, turn.id, {
            reason: "cancelled",
            cancelReason: control.interruptedAtMs !== null ? control.cancelReason : "not_heard",
            output: { text: finalText, mediaEventIds: [] },
            toolCallIds,
            latency,
          });
        } catch (error) {
          terminalWriteMayBeLate = error instanceof BackendUnavailableError;
          this.#markPersistenceDegraded();
          throw error;
        }
        if (terminal.status !== "cancelled") {
          if (terminal.status === "completed") {
            this.#policy.recordTurn(transcript, finalText);
            await this.#memoryCoordinator
              .updateMemory(turn.id, transcript, finalText)
              .catch(() => undefined);
          } else {
            this.#turnsFailed += 1;
          }
          reportTurnLatency(
            this.#options.onTurnLatency,
            this.#options.session.id,
            turn,
            terminal.status,
            latency,
          );
          reportAssistantText(
            this.#options.onAssistantText,
            this.#options.session.id,
            turn,
            terminal.status,
            finalText,
            textDelivered,
            audioError,
          );
          this.#recordTerminalTurn(terminal);
          if (terminal.status === "failed") {
            this.#emitVoiceEvent({
              kind: "error",
              error: terminal.error,
              recoverable: terminal.error.retriable,
            });
          }
          emitTurnCompleted(terminal.status);
          return;
        }
        if (control.interruptedAtMs !== null && control.cancelReason === "barge_in") {
          const alignedText = control.alignedDurationMs > 0 ? alignedTextForHistory(control) : "";
          const interruptedText = alignedText || finalText;
          this.#policy.recordInterruptedTurn(transcript, interruptedText);
          await this.#memoryCoordinator
            .updateMemory(turn.id, transcript, interruptedText, true)
            .catch(() => undefined);
        }
        this.#recordTerminalTurn(terminal);
        reportTurnLatency(
          this.#options.onTurnLatency,
          this.#options.session.id,
          turn,
          "cancelled",
          latency,
        );
        reportAssistantText(
          this.#options.onAssistantText,
          this.#options.session.id,
          turn,
          "cancelled",
          finalText,
          textDelivered,
          audioError,
        );
        emitTurnCompleted("cancelled");
        return;
      }

      let terminal: TerminalTurn;
      try {
        terminal = await this.#options.runtime.endTurn(this.#options.session.id, turn.id, {
          reason: "completed",
          output: { text: finalText, mediaEventIds: [] },
          toolCallIds,
          latency,
        });
      } catch (error) {
        terminalWriteMayBeLate = error instanceof BackendUnavailableError;
        this.#markPersistenceDegraded();
        throw error;
      }
      if (terminal.status !== "completed") {
        if (terminal.status === "failed") this.#turnsFailed += 1;
        reportTurnLatency(
          this.#options.onTurnLatency,
          this.#options.session.id,
          turn,
          terminal.status,
          latency,
        );
        reportAssistantText(
          this.#options.onAssistantText,
          this.#options.session.id,
          turn,
          terminal.status,
          finalText,
          textDelivered,
          audioError,
        );
        this.#recordTerminalTurn(terminal);
        if (terminal.status === "failed") {
          this.#emitVoiceEvent({
            kind: "error",
            error: terminal.error,
            recoverable: terminal.error.retriable,
          });
        }
        emitTurnCompleted(terminal.status);
        return;
      }
      reportTurnLatency(
        this.#options.onTurnLatency,
        this.#options.session.id,
        turn,
        "completed",
        latency,
      );
      reportAssistantText(
        this.#options.onAssistantText,
        this.#options.session.id,
        turn,
        "completed",
        finalText,
        textDelivered,
        audioError,
      );
      this.#policy.recordTurn(transcript, finalText);
      await this.#memoryCoordinator
        .updateMemory(turn.id, transcript, finalText)
        .catch(() => undefined);
      this.#recordTerminalTurn(terminal);
      emitTurnCompleted("completed");
    } catch (error) {
      latency.totalMs = this.#durationSince(startedAtMs);
      const turnError = normalizeUnknownError(error, {
        code: "turn.failed",
        category: "internal",
        retriable: false,
      });
      let terminalPersisted = true;
      let terminal: TerminalTurn | undefined;
      terminal =
        (await (terminalWriteMayBeLate
          ? awaitTerminalTurn(this.#options.runtime, this.#options.session.id, turn.id)
          : readTerminalTurn(this.#options.runtime, this.#options.session.id, turn.id))) ??
        undefined;
      if (!terminal) {
        terminal = await this.#options.runtime
          .endTurn(this.#options.session.id, turn.id, {
            reason: "failed",
            error: turnError,
            output: { text: finalText, mediaEventIds: [] },
            toolCallIds,
            latency,
          })
          .catch(async () => {
            terminalPersisted = false;
            const lateTerminal = await awaitTerminalTurn(
              this.#options.runtime,
              this.#options.session.id,
              turn.id,
            );
            if (lateTerminal) terminalPersisted = true;
            return lateTerminal ?? undefined;
          });
      }
      if (!terminalPersisted) this.#markPersistenceDegraded();
      if (terminal && terminal.status !== "failed") {
        // A late successful/cancelled terminal write won the race. Do not
        // report the same turn as failed or overwrite its durable outcome.
        reportTurnLatency(
          this.#options.onTurnLatency,
          this.#options.session.id,
          turn,
          terminal.status,
          latency,
        );
        reportAssistantText(
          this.#options.onAssistantText,
          this.#options.session.id,
          turn,
          terminal.status,
          finalText,
          textDelivered,
          audioError,
        );
        if (terminal.status === "completed") {
          this.#policy.recordTurn(transcript, finalText);
          await this.#memoryCoordinator
            .updateMemory(turn.id, transcript, finalText)
            .catch(() => undefined);
        }
        if (terminal) this.#recordTerminalTurn(terminal);
        emitTurnCompleted(terminal.status);
        return;
      }
      this.#turnsFailed += 1;
      this.#firstTurnError ??= turnError;
      reportTurnLatency(
        this.#options.onTurnLatency,
        this.#options.session.id,
        turn,
        "failed",
        latency,
      );
      reportAssistantText(
        this.#options.onAssistantText,
        this.#options.session.id,
        turn,
        "failed",
        finalText,
        textDelivered,
        audioError,
      );
      if (terminal) this.#recordTerminalTurn(terminal);
      const reportedError = terminal?.status === "failed" ? terminal.error : turnError;
      this.#emitVoiceEvent({
        kind: "error",
        error: reportedError,
        recoverable: reportedError.retriable,
      });
      emitTurnCompleted("failed");
    } finally {
      detachControlSignal();
      detachAttachmentClear();
      await incrementalInput?.cancel().catch(() => undefined);
      await incrementalPlayback?.catch(() => undefined);
      this.#sttInput.cancelBargeInCandidate();
      this.#active = null;
    }
  }

  async #interrupt(cause: "barge_in" | "dtmf" | "explicit" | "timeout"): Promise<void> {
    const control = this.#active;
    if (!control || control.interruptedAtMs !== null) {
      return;
    }
    if (cause !== "explicit" && this.#options.agent.interruptionPolicy.mode === "ignore") {
      return;
    }

    control.interruptedAtMs = this.#monotonicMs();
    control.cancelReason = cause;
    this.#interruptions += 1;
    this.#sttInput.cancelBargeInCandidate();
    control.abort.abort();
    control.interruptionCheckpoint = persistInterruptionCheckpoint({
      runtime: this.#options.runtime,
      sessionId: this.#options.session.id,
      turnId: control.turnId,
      cause,
      onDegraded: () => this.#markPersistenceDegraded(),
    });
    const checkpoint = control.interruptionCheckpoint;
    this.#persistenceGate = this.#persistenceGate
      .then((previous) => (previous ? checkpoint : false))
      .catch(() => false);
    if (this.#options.agent.interruptionPolicy.trimOutputOnInterrupt) {
      await this.#trimOutput();
    }
    // The tail is decision to queued-output-stopped, which is what the caller hears as
    // the agent talking over them. It is not proof the transport had already played it.
    control.interruptionTailMs = Math.max(0, this.#monotonicMs() - control.interruptedAtMs);
  }

  async #trimOutput(): Promise<void> {
    await withTimeout(this.#options.callHandle.clear(), pipelineConstants.CLEAR_TIMEOUT_MS).catch(
      () => undefined,
    );
  }

  async #runLlm(
    turn: Turn,
    messages: readonly LlmMessage[],
    control: ActiveTurnControl,
    latency: MutableTurnLatency,
    onText?: (text: string) => Promise<void>,
  ): Promise<{ readonly text: string; readonly toolCalls: readonly LlmInlineToolCall[] }> {
    let sawCompleted = false;
    const toolList = this.#memoryCoordinator.resolveToolList();
    const completion = await raceStartup(
      this.#providers.llm.complete({
        sessionId: this.#options.session.id,
        turnId: turn.id,
        model: this.#options.llmModel,
        messages,
        tools: toolList,
        stream: true,
        temperature: 0.2,
        ...(this.#options.safetyIdentifier
          ? { safetyIdentifier: this.#options.safetyIdentifier }
          : {}),
        signal: control.abort.signal,
      }),
      control.abort.signal,
      (handle) => handle.cancel(),
      {
        timeoutMs: pipelineConstants.STARTUP_TIMEOUT_MS,
        timeoutReason: timeoutError(
          "llm.open_timeout",
          `LLM startup timed out after ${pipelineConstants.STARTUP_TIMEOUT_MS}ms`,
        ),
      },
    );
    if (!completion) {
      return { text: "", toolCalls: [] };
    }
    const accumulator = new PipelineLlmAccumulator({
      cancel: () => cancelLlmCompletion(completion),
      ...(onText ? { onText } : {}),
    });

    const iterator = completion.events[Symbol.asyncIterator]();
    const aborted = abortPromise(control.abort.signal);
    try {
      while (true) {
        const stall = stallTimer(this.#stallTimeoutMs);
        const next = iterator.next();
        next.catch(() => undefined);
        const step = await Promise.race([
          next.then((result) => ({ kind: "event" as const, result })),
          aborted.then(() => ({ kind: "abort" as const })),
          stall.promise.then(() => ({ kind: "timeout" as const })),
        ]);
        stall.cancel();

        if (step.kind === "timeout") {
          await cancelLlmCompletion(completion);
          if (this.#onTimeout === "interrupt") {
            this.#abortActive("timeout");
            break;
          }
          throw TvicThrowableError.from(
            timeoutError("llm.stalled", `LLM produced no event for ${this.#stallTimeoutMs}ms`),
          );
        }
        if (step.kind === "abort") {
          await cancelLlmCompletion(completion);
          break;
        }
        if (step.result.done) {
          if (!sawCompleted && !control.abort.signal.aborted) {
            throw TvicThrowableError.from(
              internalError(
                "llm.stream_incomplete",
                "LLM stream ended before a completion event was received",
              ),
            );
          }
          break;
        }

        const event = step.result.value;
        await accumulator.recordEvent();
        if (event.type === "llm.token") {
          if (control.abort.signal.aborted) break;
          latency.firstTokenMs ??= this.#durationSince(control.startedAtMs);
          await accumulator.appendText(event.text);
        } else if (event.type === "llm.tool_call") {
          await accumulator.addToolCall(event.call);
        } else if (event.type === "llm.completed") {
          if (control.abort.signal.aborted) break;
          sawCompleted = true;
          await accumulator.complete(event.text, event.toolCalls);
        } else if (event.type === "llm.failed") {
          await cancelLlmCompletion(completion);
          throw TvicThrowableError.from(event.error);
        }
      }
      return { text: accumulator.text.trim(), toolCalls: accumulator.toolCalls };
    } finally {
      await closeAsyncIterator(iterator, "LLM event iterator cleanup timed out");
    }
  }

  async #executeToolCalls(
    turn: Turn,
    calls: readonly LlmInlineToolCall[],
    control: ActiveTurnControl,
    latency: MutableTurnLatency,
  ): Promise<{
    readonly messages: readonly LlmMessage[];
    readonly toolCallIds: readonly ToolCallId[];
    readonly assistantToolCalls: readonly LlmInlineToolCall[];
  }> {
    const messages: LlmMessage[] = [];
    const toolCallIds: ToolCallId[] = [];
    const assistantToolCalls: LlmInlineToolCall[] = [];

    for (const call of calls) {
      if (control.abort.signal.aborted) {
        break;
      }
      const tool =
        call.toolName === "remember_fact"
          ? this.#memoryCoordinator.memoryTool
          : this.#policy.findTool(call);
      const inputError = tool
        ? call.input === REDACTED_TOOL_INPUT
          ? validationError(
              "tool.input_not_serializable",
              "Tool input cannot be persisted: provider input was not serializable",
            )
          : toolInputError(call.input, tool.inputSchema)
        : null;
      const persistedInput = inputError ? REDACTED_TOOL_INPUT : serializableToolValue(call.input);
      assistantToolCalls.push({ ...call, input: persistedInput });
      if (!tool) {
        const error = internalError("tool.not_found", "Requested tool is not registered");
        const toolCallId = this.#ids.toolCall();
        const timestamp = new Date().toISOString() as Timestamp;
        await recordToolCall(
          this.#options.runtime,
          {
            status: "failed",
            toolCallId,
            toolId: `${call.toolName}` as ToolId,
            toolName: call.toolName,
            sessionId: this.#options.session.id,
            turnId: turn.id,
            input: persistedInput,
            attempts: 1,
            queuedAt: timestamp,
            startedAt: timestamp,
            endedAt: timestamp,
            error,
            metadata: { unknownTool: true },
          },
          () => this.#markPersistenceDegraded(),
        );
        toolCallIds.push(toolCallId);
        this.#emitVoiceEvent({
          kind: "tool_call",
          toolCallId,
          toolName: String(call.toolName),
          input: persistedInput,
        });
        messages.push({
          role: "tool",
          content: safeJsonStringify({ error: { code: error.code, message: error.message } }),
          toolName: call.toolName,
          toolCallRef: call.callRef,
        });
        this.#emitVoiceEvent({
          kind: "tool_result",
          toolCallId,
          output: { error: { code: error.code, message: error.message } },
          latencyMs: 0,
        });
        this.#emitVoiceEvent({
          kind: "error",
          error,
          recoverable: error.retriable,
        });
        continue;
      }

      const toolCallId = this.#ids.toolCall();
      const startedAtMs = this.#monotonicMs();
      toolCallIds.push(toolCallId);
      this.#emitVoiceEvent({
        kind: "tool_call",
        toolCallId,
        toolName: String(call.toolName),
        input: persistedInput,
      });
      const idempotencyKey = inputError
        ? null
        : idempotencyKeyFor({
            tool,
            input: call.input,
            sessionId: this.#options.session.id,
            turnId: turn.id,
            toolCallId,
          });
      const queued: QueuedToolCall = {
        status: "queued",
        toolCallId,
        toolId: tool.id,
        toolName: tool.name,
        sessionId: this.#options.session.id,
        turnId: turn.id,
        input: persistedInput,
        attempts: 1,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        queuedAt: new Date().toISOString() as Timestamp,
      };
      let result: TerminalToolCall;
      if (inputError) {
        result = await recordToolCall(
          this.#options.runtime,
          {
            ...queued,
            status: "failed",
            startedAt: queued.queuedAt,
            endedAt: new Date().toISOString() as Timestamp,
            error: inputError,
            metadata: { inputRedacted: true },
          },
          () => this.#markPersistenceDegraded(),
        );
      } else {
        const running = await startToolCall(this.#options.runtime, queued, () =>
          this.#markPersistenceDegraded(),
        );
        try {
          const executed = await executeTool({
            tool,
            input: call.input,
            sessionId: this.#options.session.id,
            turnId: turn.id,
            toolCallId,
            queuedAt: queued.queuedAt,
            signal: control.abort.signal,
            idempotencyStore: this.#idempotency,
            ...(this.#options.attachment?.lease
              ? {
                  lease: {
                    sessionId: this.#options.session.id,
                    holder: this.#options.attachment.lease.holder,
                    fence: this.#options.attachment.lease.fence,
                  },
                }
              : {}),
            ...(this.#memoryUserId || this.#organizationId || this.#workflowId
              ? {
                  tenant: {
                    ...(this.#memoryUserId ? { userId: this.#memoryUserId } : {}),
                    ...(this.#organizationId ? { organizationId: this.#organizationId } : {}),
                    ...(this.#workflowId ? { workflowId: this.#workflowId } : {}),
                  },
                }
              : {}),
          });
          if (!isTerminalToolCall(executed)) {
            throw TvicThrowableError.from(
              internalError(
                "tool.invalid_terminal_state",
                "Tool execution did not produce a terminal call",
              ),
            );
          }
          result = executed;
        } catch (error) {
          result = {
            ...running,
            status: "failed",
            endedAt: new Date().toISOString() as Timestamp,
            error: normalizeUnknownError(error, {
              code: "tool.execution_failed",
              category: "internal",
              retriable: false,
            }),
          };
        }
        result = await finishToolCall(this.#options.runtime, result, () =>
          this.#markPersistenceDegraded(),
        );
      }
      const toolLatencyMs = this.#durationSince(startedAtMs);
      latency.toolMs = (latency.toolMs ?? 0) + toolLatencyMs;
      const toolOutput =
        result.status === "succeeded"
          ? result.output
          : {
              error: {
                code: "error" in result ? result.error.code : "tool.failed",
                message: "error" in result ? result.error.message : "Tool failed",
              },
            };
      this.#emitVoiceEvent({
        kind: "tool_result",
        toolCallId,
        output: serializableToolValue(toolOutput),
        latencyMs: toolLatencyMs,
      });

      if (result.status === "succeeded") {
        messages.push({
          role: "tool",
          content: safeJsonStringify(result.output),
          toolName: tool.name,
          toolCallRef: call.callRef,
        });
      } else if (result.status === "cancelled") {
        break;
      } else {
        const error =
          "error" in result ? result.error : internalError("tool.failed", "Tool failed");
        messages.push({
          role: "tool",
          content: safeJsonStringify({ error: { code: error.code, message: error.message } }),
          toolName: tool.name,
          toolCallRef: call.callRef,
        });
      }
    }
    return { messages, toolCallIds, assistantToolCalls };
  }

  #monotonicMs(): number {
    return this.#options.runtime.sessionClockMs(this.#options.session.id);
  }

  #durationSince(startedAtMs: number): number {
    return Math.max(0, this.#monotonicMs() - startedAtMs);
  }
}

export async function runPipelineVoiceLoop(
  options: PipelineVoiceLoopOptions,
): Promise<PipelineVoiceLoopResult> {
  return new PipelineVoiceLoop(options).run();
}
