import { InMemoryToolIdempotencyStore } from "@tvic/tools";
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
  Memory,
  NormalizedError,
  QueuedToolCall,
  Runtime,
  SessionAttachment,
  SttStream,
  ToolCallId,
  TerminalToolCall,
  TerminalTurn,
  ToolIdempotencyStore,
  Turn,
  UserId,
  OrganizationId,
  WorkflowId,
} from "@tvic/core";
import { reportAssistantText } from "./assistant-text.js";
import type { SttReconnectOptions } from "./resilient-stt.js";
import type { AssistantTextRecord } from "./assistant-text.js";
import { cancelWithTimeout, withTimeout } from "./async-control.js";
import { ConversationPolicy } from "./conversation-policy.js";
import { deliverAssistantText } from "./text-delivery.js";
import { withSttReconnect } from "./resilient-stt.js";
import { getSttRecoveryControl } from "./resilient-stt.js";
import { assertMemoryPolicySupported } from "./memory-capabilities.js";
import type { SttCommandController } from "./stt-command-controller.js";
import { SerialSttCommandController } from "./stt-command-controller.js";
import { PipelineSttInput } from "./pipeline-stt-input.js";
import * as pipelineConstants from "./pipeline-constants.js";
import type { TextDeliveryMode } from "./text-delivery.js";
import { persistInterruptionCheckpoint } from "./persistence-policy.js";
import {
  cancellationReason,
  awaitTerminalTurn,
  linkAbortSignal,
  readTerminalTurn,
} from "./pipeline-helpers.js";
import { appendTurnMemory, type TurnMemoryContext } from "./pipeline-tool-exec.js";
import {
  attachmentAbortReason,
  metadataString,
  truncateErrorCause,
  truncateToolInput,
} from "./pipeline-payload-budgets.js";
import { alignedTextForHistory } from "./turn-alignment.js";
import { reportTurnLatency } from "./turn-state.js";
import { PipelineTurnOutput } from "./pipeline-turn-output.js";
import { DualProtocolResultImpl } from "./dual-protocol-result.js";
import { PipelineVoiceLoopBuilder } from "./pipeline-loop-builder.js";
import type { DualProtocolResult, VoiceEvent } from "./voice-event.js";
import { drainAsyncIterator } from "./pipeline-loop-boundary.js";
import { PipelineTerminalCoordinator } from "./pipeline-terminal-boundary.js";
import type { LiveTerminalSource } from "./terminal-arbitration.js";
import type {
  ActiveTurnControl,
  MutableTurnLatency,
  TurnLatencyRecord,
  UtteranceTiming,
} from "./turn-state.js";
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

export type PipelineVoiceLoopTerminalReason =
  | "completed"
  | "cancelled"
  | "failed"
  | "remote_hangup";

export interface PipelineVoiceLoopResult {
  readonly session: ActiveSession;
  readonly turnsHandled: number;
  readonly interruptions: number;
  readonly turnsFailed: number;
  readonly firstTurnError: NormalizedError | null;
  /**
   * Terminal reason for RESOLVED runs (additive; existing readers ignore it).
   * Precedence: cancelled (explicit cancel/abort won) > failed (one or more
   * failed turns, or a timeout/error stream end) > remote_hangup >
   * completed. Rejected runs carry their terminal in the rejection instead;
   * unified cancel/remote arbitration with scheduler batches is joint T1
   * work — this field reports the resolved outcome only.
   */
  readonly terminalReason: PipelineVoiceLoopTerminalReason;
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
  readonly #turnOutput: PipelineTurnOutput;
  readonly #turnEndpointTimeoutMs: number;
  readonly #turnMaxDurationMs: number;
  #turnsHandled = 0;
  #turnsFailed = 0;
  #firstTurnError: NormalizedError | null = null;
  #interruptions = 0;
  #turnChain: Promise<void> = Promise.resolve();
  #active: ActiveTurnControl | null = null;
  #shutdownReason: string | null = null;
  #inputEnded = false;
  #eventOverflowError: unknown = null;
  #removeRecoveryListener: (() => void) | undefined;
  readonly #sttInput: PipelineSttInput;
  #persistenceDegraded = false;
  #persistenceGate: Promise<boolean> = Promise.resolve(true);
  readonly #memoryUserId: UserId | undefined;
  readonly #organizationId: OrganizationId | undefined;
  readonly #workflowId: WorkflowId | undefined;
  readonly #memory: Memory | undefined;
  readonly #terminal: PipelineTerminalCoordinator;
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
    this.#turnEndpointTimeoutMs =
      options.turnEndpointTimeoutMs ?? pipelineConstants.DEFAULT_TURN_ENDPOINT_TIMEOUT_MS;
    this.#turnMaxDurationMs =
      options.turnMaxDurationMs ?? pipelineConstants.DEFAULT_TURN_MAX_DURATION_MS;
    this.#idempotency = options.runtime.toolIdempotencyStore ?? new InMemoryToolIdempotencyStore();
    this.#terminal = new PipelineTerminalCoordinator({
      ...(options.attachment?.signal ? { attachmentSignal: options.attachment.signal } : {}),
      ...(options.terminalSourceForCancellation
        ? { sourceForCancellation: options.terminalSourceForCancellation }
        : {}),
    });
    this.#sttInput = new PipelineSttInput({
      sessionId: options.session.id,
      callHandle: options.callHandle,
      policy: this.#policy,
      interruptionPolicy: options.agent.interruptionPolicy,
      endpointTimeoutMs: this.#turnEndpointTimeoutMs,
      maxDurationMs: this.#turnMaxDurationMs,
      now: () => this.#monotonicMs(),
      getActive: () => this.#active,
      onTranscript: (transcript, timing) => {
        // R2-05: late transcripts after input end never create post-shutdown
        // turns (drop + count via turnsHandled staying flat).
        if (this.#inputEnded) return;
        // Rejection continuity: a poisoned chain must not skip all later
        // turns. #handleTranscript is total (it records its own failures),
        // so this backstop only fires on truly unexpected throws.
        const runTurn = (): Promise<void> => this.#handleTranscript(transcript, timing);
        this.#turnChain = this.#turnChain.then(runTurn, runTurn);
      },
      interrupt: (cause) => this.#interrupt(cause),
      onIteratorTimeout: () => this.#cancellationTimeout("stt.iterator.return"),
    });
    this.#turnOutput = new PipelineTurnOutput({
      options,
      providers: this.#providers,
      ids: this.#ids,
      policy: this.#policy,
      idempotency: this.#idempotency,
      memory: this.#memory,
      memoryUserId: this.#memoryUserId,
      organizationId: this.#organizationId,
      workflowId: this.#workflowId,
      emitVoiceEvent: (event) => this.#emitVoiceEvent(event),
      startToolCall: (queued) => this.#startToolCall(queued),
      finishToolCall: (result) => this.#finishToolCall(result),
      recordToolCall: (result) => this.#recordToolCall(result),
      monotonicMs: () => this.#monotonicMs(),
      abortActive: (reason) => this.#abortActive(reason),
      cancellationTimeout: (stage) => this.#cancellationTimeout(stage),
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
        consumer: options.consumer ?? "internal",
      });
    }
    this.#runStarted = true;
    this.#runConsumer = options.consumer ?? "internal";
    this.#runOverrideSignal = options.overrideSignal;
    // R2-05 LOCKED: bounded run-events queue (1024). A caller that awaits
    // but never iterates cannot grow memory without bound; overflow fails
    // the run terminal (never silent drop).
    const events = new AsyncQueue<VoiceEvent>({ maxBuffered: 1024 });
    this.#runEvents = events;
    this.#runCancelled = false;
    this.#runEndReason = undefined;
    this.#eventOverflowError = null;
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
    // Keep the public promise from hanging if an exception escapes the
    // body's own failure handler (for example, an observer or cleanup hook
    // throws while the body is already reporting an error). The normal path
    // settles both channels inside #runBody; this is only the last-resort
    // boundary for an unexpected implementation failure.
    void this.#runBody(events, resolveRun, rejectRun).catch((error: unknown) => {
      const normalized = TvicThrowableError.from(
        normalizeUnknownError(error, {
          code: "voice_runtime.run_failed",
          category: "internal",
          retriable: false,
        }),
      );
      events.fail(normalized);
      rejectRun(normalized);
    });
    const consumer = this.#runConsumer;
    if (consumer === "internal") {
      const iterator = events[Symbol.asyncIterator]();
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
      consumer,
    });
    return result;
  }

  #emitVoiceEvent(event: VoiceEvent): void {
    const queue = this.#runEvents;
    if (!queue) return;
    // R2-08: central payload budgets — truncate oversized error causes and
    // tool inputs at the event boundary (JSON-safe, counted).
    let bounded = event;
    if (event.kind === "error") {
      bounded = { ...event, error: truncateErrorCause(event.error) };
    } else if (event.kind === "tool_call") {
      bounded = { ...event, input: truncateToolInput(event.input) };
    }
    // R2-05: never silently drop. On overflow, latch a terminal error and
    // fail the queue so iterators observe the failure explicitly (buffered
    // events are superseded by the terminal failure — overflow is
    // pathological by construction). #runLegacy throws the latched error
    // after draining turns so awaiters reject with the same value.
    if (!queue.push(bounded) && !queue.isClosed) {
      // Consumer-initiated close (break/abort) drops late emits by design —
      // the terminal outcome is already determined as cancelled. Only an
      // UNcancelled overflow (slow consumer, run still live) fails terminal.
      if (this.#runCancelled || this.#effectiveSignal()?.aborted) return;
      const overflow = TvicThrowableError.from(
        internalError("voice_runtime.events_overflow", "Voice event queue overflowed its bound"),
      );
      this.#eventOverflowError ??= overflow;
      this.#runEventError ??= overflow;
      queue.fail(this.#eventOverflowError);
      this.#runSupervisor?.abort(overflow);
    }
  }

  async #runBody(
    events: AsyncQueue<VoiceEvent>,
    resolveRun: (result: PipelineVoiceLoopResult) => void,
    rejectRun: (reason: unknown) => void,
  ): Promise<void> {
    try {
      const result = await this.#runLegacy(events);
      const eventError = this.#runEventError ?? this.#eventOverflowError;
      if (eventError) {
        const overflow = TvicThrowableError.from(eventError);
        events.fail(overflow);
        rejectRun(overflow);
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
      const terminalEventError = this.#runEventError ?? this.#eventOverflowError;
      if (terminalEventError) {
        const overflow = TvicThrowableError.from(terminalEventError);
        events.fail(overflow);
        rejectRun(overflow);
        return;
      }
      events.close();
      resolveRun({
        ...result,
        terminalReason: claim.kind,
        terminalSource: claim.source,
      });
      return;
    } catch (err) {
      // Queue overflow is the terminal failure, even if aborting the run
      // causes a secondary cancellation/error to arrive through the normal
      // failure path. Both consumers must observe the same bounded-queue
      // error rather than an incidental follow-up error.
      if (this.#eventOverflowError) {
        const overflow = TvicThrowableError.from(this.#eventOverflowError);
        events.fail(overflow);
        rejectRun(overflow);
        return;
      }
      if (this.#runEventError) {
        const eventError = TvicThrowableError.from(this.#runEventError);
        events.fail(eventError);
        rejectRun(eventError);
        return;
      }
      const normalized = truncateErrorCause(
        normalizeUnknownError(err, {
          code: "turn.failed",
          category: "internal",
          retriable: false,
        }),
      );
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
      const terminalEventError = this.#runEventError ?? this.#eventOverflowError;
      if (terminalEventError) {
        const overflow = TvicThrowableError.from(terminalEventError);
        events.fail(overflow);
        rejectRun(overflow);
        return;
      }
      events.close();
      // R2-08 LOCKED: awaiters reject with the SAME normalized value the
      // iterator yields (no waiver, no raw leak).
      rejectRun(TvicThrowableError.from(normalized));
    } finally {
      this.#removeRunAbortListener?.();
      this.#removeRunAbortListener = undefined;
      this.#runOverrideSignal = undefined;
      this.#runSupervisor = undefined;
      this.#runEvents = undefined;
    }
  }

  async #runLegacy(_events: AsyncQueue<VoiceEvent>): Promise<PipelineVoiceLoopResult> {
    const startupAbort = new AbortController();
    this.#runSupervisor = startupAbort;
    if (this.#runCancelled || this.#effectiveSignal()?.aborted) {
      startupAbort.abort();
    }
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
        void opening
          .then((lateStream) =>
            cancelWithTimeout(
              () => lateStream.close(),
              pipelineConstants.CANCELLATION_TIMEOUT_MS,
              () => this.#cancellationTimeout("stt.late_open_close"),
            ),
          )
          .catch(() => undefined);
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
    if (this.#runCancelled || this.#effectiveSignal()?.aborted) {
      supervisor.abort();
    }
    const detachSupervisorSignal = linkAbortSignal(this.#effectiveSignal(), supervisor);
    let sttError: unknown = null;
    let sttEnded = false;
    commandController.failure.catch((error) => {
      // Already-normalized/marked failures pass through untouched (codes +
      // retriability preserved — verified by failure-normalization tests).
      // Truly raw failures arrive pre-wrapped by the controller as internal;
      // the failure is terminal for this run either way (retry decisions for
      // future generations live in the resilient-STT policy mapping, not
      // in this terminal code). Defaults below only cover an unwrapped shape.
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
    const transcriptTask = this.#sttInput.consumeTranscripts(stt.events, supervisor.signal);
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

    // R2-05: input is over for NON-graceful ends — late transcripts from
    // here on are dropped by the onTranscript gate (never a post-shutdown
    // turn). Graceful ends keep the gate open through the terminal
    // commit+flush+drain below so delayed trailing speech still commits.
    const gracefulEnd = mediaEnded && endReason === "completed" && !sttError;
    if (!gracefulEnd) {
      this.#inputEnded = true;
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

    if (gracefulEnd && !sttEnded) {
      const terminalFlush = this.#sttInput.commitAndFlush(stt, commandController);
      this.#sttInput.pendingCommitFlushes.add(terminalFlush);
      void terminalFlush
        .finally(() => this.#sttInput.pendingCommitFlushes.delete(terminalFlush))
        .catch(() => undefined);
      let terminalFlushTimedOut = false;
      try {
        await withTimeout(
          Promise.allSettled(this.#sttInput.pendingCommitFlushes),
          pipelineConstants.TRANSCRIPT_DRAIN_TIMEOUT_MS,
          timeoutError(
            "stt.drain_timeout",
            `STT terminal commit drain timed out after ${pipelineConstants.TRANSCRIPT_DRAIN_TIMEOUT_MS}ms`,
            { retriable: false },
          ),
        );
      } catch (error) {
        // The provider-specific send/commit timeout is configurable and may
        // exceed the pipeline's shutdown budget. The terminal flush itself
        // must still be bounded, otherwise graceful shutdown can wait longer
        // than the documented transcript-drain deadline.
        terminalFlushTimedOut = true;
        sttError ??= error;
        supervisor.abort();
      }
      if (terminalFlushTimedOut) {
        await cancelWithTimeout(
          () => commandController.abort(sttError ?? new Error("STT terminal drain timed out")),
          pipelineConstants.CANCELLATION_TIMEOUT_MS,
          () => this.#cancellationTimeout("stt.abort"),
        ).catch(() => undefined);
      } else {
        try {
          await cancelWithTimeout(
            () => commandController.drain(),
            pipelineConstants.CANCELLATION_TIMEOUT_MS,
            () => this.#cancellationTimeout("stt.drain"),
          );
        } catch (error) {
          // A provider command that could not drain is a call failure even when
          // its event iterator closes cleanly during forced teardown. Preserve
          // the precise timeout/provider error for the terminal rejection.
          sttError ??= error;
          supervisor.abort();
        }
      }
      // Graceful flush done — catch straggler finals that arrived after the
      // barrier resolved (commitMode:none immediate-flush race) before
      // closing the gate below.
      const straggler = this.#sttInput.flushTrailing();
      if (straggler) {
        const runStraggler = (): Promise<void> =>
          this.#handleTranscript(straggler, {
            endpointAtMs: this.#monotonicMs(),
          });
        this.#turnChain = this.#turnChain.then(runStraggler, runStraggler);
      }
      // Graceful flush done — gate late transcripts from here on.
      this.#inputEnded = true;
    } else {
      // Caller/media shutdown preempts commit grace before stream close; otherwise
      // a late promise could flush a new turn after hangup.
      supervisor.abort(sttError ?? new Error("STT input ended"));
      await cancelWithTimeout(
        () => commandController.abort(sttError ?? new Error("STT input ended")),
        pipelineConstants.CANCELLATION_TIMEOUT_MS,
        () => this.#cancellationTimeout("stt.abort"),
      ).catch(() => undefined);
    }

    // Graceful ends keep in-flight work: the trailing turn(s) below run to
    // completion (their audio may still deliver). Every other shutdown
    // aborts the active turn so no stale synthesis continues.
    if (sttError) {
      this.#shutdownReason = "stt_error";
    }
    if (!gracefulEnd || sttError) {
      this.#abortActive(this.#shutdownReason);
    }
    this.#sttInput.cancelBargeInCandidate();
    // The command controller owns the STT stream close. Calling stt.close()
    // again here creates a real double-close hazard for custom providers and
    // is unnecessary for reconnectable streams, whose controller is the
    // resilient stream itself.
    this.#removeRecoveryListener?.();
    this.#removeRecoveryListener = undefined;
    detachSupervisorSignal();
    // R2-05: bound the transcript drain — a provider that never closes its
    // events must not hold the session forever. On timeout the late
    // transcripts are dropped by the #inputEnded gate above.
    try {
      await withTimeout(
        transcriptTask,
        pipelineConstants.TRANSCRIPT_DRAIN_TIMEOUT_MS,
        timeoutError(
          "stt.drain_timeout",
          `STT transcript drain timed out after ${pipelineConstants.TRANSCRIPT_DRAIN_TIMEOUT_MS}ms`,
          { retriable: false },
        ),
      );
    } catch (error) {
      await this.#turnChain.catch(() => undefined);
      throw error;
    }
    await this.#turnChain;

    // R2-05: event-queue overflow fails the run terminal (both channels).
    if (this.#eventOverflowError) {
      throw TvicThrowableError.from(
        normalizeUnknownError(this.#eventOverflowError, {
          code: "voice_runtime.events_overflow",
          category: "internal",
          retriable: false,
        }),
      );
    }

    if (streamError) {
      throw TvicThrowableError.from(streamError);
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
      terminalReason: this.#resolveTerminalReason(),
      terminalSource: this.#terminal.sourceForEndReason(this.#runEndReason ?? "completed"),
    };
  }

  #resolveTerminalReason(): PipelineVoiceLoopTerminalReason {
    if (this.#runCancelled || this.#effectiveSignal()?.aborted) return "cancelled";
    if (this.#turnsFailed > 0) return "failed";
    if (this.#runEndReason === "remote_hangup") return "remote_hangup";
    if (this.#runEndReason === "timeout" || this.#runEndReason === "error") return "failed";
    if (this.#runEndReason === "cancelled") return "cancelled";
    return "completed";
  }

  #abortActive(reason: string): void {
    const control = this.#active;
    if (control && control.interruptedAtMs === null && !control.outputDelivered) {
      control.interruptedAtMs = this.#monotonicMs();
      control.cancelReason = cancellationReason(reason);
      control.abort.abort();
    }
  }

  #cancellationTimeout(stage: string): void {
    // P-11: a provider that ignores cancellation is bounded and reported as
    // degraded; its private resources remain the provider/host's cleanup
    // responsibility and are never force-killed by TVIC. Rejection shape with
    // degraded metadata belongs to the managed layer (L-12); the runtime
    // records the degraded diagnostic on the event stream.
    this.#emitVoiceEvent({
      kind: "error",
      error: internalError(
        "voice_runtime.cancellation_timeout",
        `Provider ignored cancellation during ${stage}`,
        {
          metadata: { degraded: true, stage },
        },
      ),
      recoverable: false,
    });
  }

  #markPersistenceDegraded(): void {
    this.#persistenceDegraded = true;
    try {
      this.#options.runtime.setPersistenceHealth(this.#options.session.id, true);
    } catch {
      // Health bookkeeping is advisory. It must never replace the durable
      // failure that caused this transition.
    } finally {
      this.#active?.abort.abort();
    }
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

  async #startToolCall(
    queued: QueuedToolCall,
  ): Promise<Awaited<ReturnType<Runtime["startToolCall"]>>> {
    try {
      return await this.#options.runtime.startToolCall(queued);
    } catch (error) {
      this.#markPersistenceDegraded();
      throw error;
    }
  }

  async #finishToolCall(result: TerminalToolCall): Promise<TerminalToolCall> {
    try {
      return await this.#options.runtime.finishToolCall(result);
    } catch (error) {
      this.#markPersistenceDegraded();
      throw error;
    }
  }

  async #recordToolCall(result: TerminalToolCall): Promise<TerminalToolCall> {
    try {
      await this.#options.runtime.recordToolCall(result);
      return result;
    } catch (error) {
      this.#markPersistenceDegraded();
      throw error;
    }
  }

  async #handleTranscript(transcript: string, timing: UtteranceTiming): Promise<void> {
    // R2-05/red-P1-4 + D-03: a latched persistence gate must fail LOUD with
    // the durable-write shape (degraded metadata, identity retained via the
    // result's sessionId), never silently skip turns while media burns.
    if (this.#persistenceDegraded || !(await this.#persistenceGate)) {
      const failure = internalError(
        "durable.write.failure",
        "Turn dropped: persistence is degraded or the interruption checkpoint failed",
        { metadata: { degraded: true, source: "persistence_gate" } },
      );
      this.#turnsFailed += 1;
      this.#firstTurnError ??= failure;
      this.#emitVoiceEvent({ kind: "error", error: failure, recoverable: false });
      return;
    }
    let turn: Turn;
    try {
      turn = await this.#options.runtime.startTurn({
        sessionId: this.#options.session.id,
        input: { transcript, mediaEventIds: [] },
      });
      await this.#persistTurnStatus(turn.id, "thinking");
    } catch (error) {
      this.#markPersistenceDegraded();
      // D-03: admitted-turn write rejection surfaces the durable-write shape:
      // normalized error with degraded metadata, original session/turn
      // identity retained, recorded once. An already-normalized store error
      // keeps its code; only the degraded flag is added.
      const normalized = normalizeUnknownError(error, {
        code: "durable.write.failure",
        category: "internal",
        retriable: false,
      });
      const failure: NormalizedError = {
        ...normalized,
        metadata: { ...(normalized.metadata ?? {}), degraded: true, source: "turn_start" },
      };
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
    // Red-P1-6: graceful trailing commits (`shutdownReason === "completed"`)
    // are the caller's last utterance — run them normally instead of
    // self-cancelling. Every other shutdown reason pre-aborts.
    if (
      (this.#shutdownReason && this.#shutdownReason !== "completed") ||
      this.#options.attachment?.signal.aborted
    ) {
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
    const incrementalInput = this.#turnOutput.incrementalTtsInput(turn, control);
    const incrementalPlayback = incrementalInput
      ? incrementalInput.opened
          .then(async (opened) => {
            if (!opened) {
              control.outputDelivered = true;
              return;
            }
            await this.#turnOutput.playTtsStream(incrementalInput, control, latency);
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
          await incrementalInput.pushToken(text).catch((error: unknown) => {
            incrementalFailure ??= error;
          });
        }
      : undefined;

    try {
      await this.#resolveTurnSystemPrompt(turn);
      const messages = this.#policy.messagesForTranscript(transcript);
      const first = await this.#turnOutput.runLlm(turn, messages, control, latency, onLlmText);
      finalText = first.text;

      if (!control.abort.signal.aborted && first.toolCalls.length > 0) {
        if (incrementalInput && !incrementalFailure) {
          await incrementalInput.flushBoundary().catch((error: unknown) => {
            incrementalFailure ??= error;
          });
        }
        await this.#persistTurnStatus(turn.id, "calling_tool");
        const tools = await this.#turnOutput.executeToolCalls(
          turn,
          first.toolCalls,
          control,
          latency,
        );
        toolCallIds.push(...tools.toolCallIds);
        if (!control.abort.signal.aborted) {
          const continuation = await this.#turnOutput.runLlm(
            turn,
            this.#policy.messagesForToolContinuation(messages, first.text, tools.messages),
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
            await incrementalInput.finish();
            await incrementalPlayback;
            if (incrementalFailure) throw incrementalFailure;
          } else if (this.#providers.tts) {
            await this.#persistTurnStatus(turn.id, "speaking");
            await this.#turnOutput.speak(this.#providers.tts, turn, finalText, control, latency);
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

      textDelivered = await deliverAssistantText({
        callHandle: this.#options.callHandle,
        turn,
        text: finalText,
        ...(this.#options.textDelivery ? { mode: this.#options.textDelivery } : {}),
        audioDelivered,
        cancelledByBargeIn: control.interruptedAtMs !== null && control.cancelReason === "barge_in",
      });
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
          terminalWriteMayBeLate = isBackendUnavailableError(error);
          this.#markPersistenceDegraded();
          throw error;
        }
        if (terminal.status !== "cancelled") {
          if (terminal.status === "completed") {
            this.#policy.recordTurn(transcript, finalText);
            await this.#updateMemory(turn.id, transcript, finalText).catch(() => undefined);
          } else {
            this.#turnsFailed += 1;
          }
          this.#observeTerminalTurn({
            turn,
            terminal,
            status: terminal.status,
            finalText,
            textDelivered,
            audioError,
            latency,
            startedAtMs,
            errorEvent: terminal.status === "failed" ? terminal.error : undefined,
            emitTurnCompleted,
          });
          return;
        }
        if (control.interruptedAtMs !== null && control.cancelReason === "barge_in") {
          const alignedText = control.alignedDurationMs > 0 ? alignedTextForHistory(control) : "";
          const interruptedText = alignedText || finalText;
          this.#policy.recordInterruptedTurn(transcript, interruptedText);
          await this.#updateMemory(turn.id, transcript, interruptedText, true).catch(
            () => undefined,
          );
        }
        this.#observeTerminalTurn({
          turn,
          terminal,
          status: "cancelled",
          finalText,
          textDelivered,
          audioError,
          latency,
          startedAtMs,
          emitTurnCompleted,
        });
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
        terminalWriteMayBeLate = isBackendUnavailableError(error);
        this.#markPersistenceDegraded();
        throw error;
      }
      if (terminal.status !== "completed") {
        if (terminal.status === "failed") this.#turnsFailed += 1;
        this.#observeTerminalTurn({
          turn,
          terminal,
          status: terminal.status,
          finalText,
          textDelivered,
          audioError,
          latency,
          startedAtMs,
          errorEvent: terminal.status === "failed" ? terminal.error : undefined,
          emitTurnCompleted,
        });
        return;
      }
      this.#policy.recordTurn(transcript, finalText);
      await this.#updateMemory(turn.id, transcript, finalText).catch(() => undefined);
      this.#observeTerminalTurn({
        turn,
        terminal,
        status: "completed",
        finalText,
        textDelivered,
        audioError,
        latency,
        startedAtMs,
        emitTurnCompleted,
      });
    } catch (error) {
      latency.totalMs = this.#durationSince(startedAtMs);
      // Apply the event/persistence payload budget before writing the terminal
      // turn. Otherwise a large provider cause can make the outbox codec reject
      // the terminal write and leave the turn stuck in an active state.
      const turnError = truncateErrorCause(
        normalizeUnknownError(error, {
          code: "turn.failed",
          category: "internal",
          retriable: false,
        }),
      );
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
        if (terminal.status === "completed") {
          this.#policy.recordTurn(transcript, finalText);
          await this.#updateMemory(turn.id, transcript, finalText).catch(() => undefined);
        }
        this.#observeTerminalTurn({
          turn,
          terminal,
          status: terminal.status,
          finalText,
          textDelivered,
          audioError,
          latency,
          startedAtMs,
          emitTurnCompleted,
        });
        return;
      }
      this.#turnsFailed += 1;
      this.#firstTurnError ??= turnError;
      const reportedError = terminal?.status === "failed" ? terminal.error : turnError;
      this.#observeTerminalTurn({
        turn,
        terminal,
        status: "failed",
        finalText,
        textDelivered,
        audioError,
        latency,
        startedAtMs,
        errorEvent: reportedError,
        emitTurnCompleted,
      });
    } finally {
      detachControlSignal();
      detachAttachmentClear();
      await incrementalInput?.cancel().catch(() => undefined);
      await incrementalPlayback?.catch(() => undefined);
      this.#sttInput.cancelBargeInCandidate();
      this.#active = null;
    }
  }

  #recordTerminalTurn(turn: TerminalTurn): void {
    const attributes: Record<string, string | number | boolean> = {
      session_id: this.#options.session.id,
      turn_id: turn.id,
      status: turn.status,
      sequence: turn.sequence,
    };
    if (turn.latency.totalMs !== undefined) attributes.total_ms = turn.latency.totalMs;
    try {
      this.#options.sessionMetricsRecorder?.record("turn.end", attributes);
    } catch {
      // Metrics are observation only.
    }
    try {
      this.#options.sessionMetricsRecorder?.onTurn(turn, this.#options.session.id);
    } catch {
      // Metrics are observation only.
    }
  }

  #observeTerminalTurn(observation: {
    readonly turn: Turn;
    readonly terminal: TerminalTurn | undefined;
    readonly status: "completed" | "cancelled" | "failed";
    readonly finalText: string;
    readonly textDelivered: boolean | undefined;
    readonly audioError: NormalizedError | null;
    readonly latency: MutableTurnLatency;
    readonly startedAtMs: number;
    readonly errorEvent?: NormalizedError | undefined;
    readonly emitTurnCompleted: (status: TerminalTurn["status"]) => void;
  }): void {
    const { turn, terminal, status } = observation;
    reportTurnLatency(
      this.#options.onTurnLatency,
      this.#options.session.id,
      turn,
      status,
      observation.latency,
    );
    reportAssistantText(
      this.#options.onAssistantText,
      this.#options.session.id,
      turn,
      status,
      observation.finalText,
      observation.textDelivered,
      observation.audioError,
    );
    if (terminal) this.#recordTerminalTurn(terminal);
    if (observation.errorEvent) {
      this.#emitVoiceEvent({
        kind: "error",
        error: observation.errorEvent,
        recoverable: observation.errorEvent.retriable,
      });
    }
    observation.emitTurnCompleted(status);
  }

  async #resolveTurnSystemPrompt(turn: Turn): Promise<void> {
    const resolver = this.#options.agent.persona?.systemPromptForTurn;
    if (!resolver) {
      return;
    }
    try {
      const result = await withTimeout(
        resolver({
          sessionId: this.#options.session.id,
          turnNumber: turn.sequence,
        }),
        1_000,
      );
      this.#policy.setTurnSystemInstruction(result.instructionsOverride);
    } catch {
      // Per-turn persona context is advisory. Retain the session-level prompt
      // if the resolver is slow, unavailable, or throws.
      this.#policy.setTurnSystemInstruction(undefined);
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

  #memoryContext(): TurnMemoryContext {
    return {
      memory: this.#memory,
      policy: this.#options.agent.memoryPolicy,
      runtime: this.#options.runtime,
      sessionId: this.#options.session.id,
      attachmentSignal: this.#options.attachment?.signal,
      userId: this.#memoryUserId,
      organizationId: this.#organizationId,
      workflowId: this.#workflowId,
    };
  }

  async #updateMemory(
    turnId: Turn["id"],
    transcript: string,
    assistantText: string,
    interrupted = false,
  ): Promise<void> {
    await appendTurnMemory(this.#memoryContext(), turnId, transcript, assistantText, interrupted);
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

function isBackendUnavailableError(error: unknown): boolean {
  if (error instanceof BackendUnavailableError) {
    return true;
  }
  try {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === "BACKEND_UNAVAILABLE"
    );
  } catch {
    return false;
  }
}
