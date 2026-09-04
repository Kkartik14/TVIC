import {
  executeTool,
  idempotencyKeyFor,
  InMemoryToolIdempotencyStore,
  toolInputError,
} from "@tvic/tools";
import {
  BackendUnavailableError,
  cancelledError,
  createDefaultIdGenerator,
  internalError,
  isTerminalSession,
  isIncrementalTextToSpeechProvider,
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
  TextToSpeechProvider,
  ToolCallId,
  TerminalToolCall,
  TerminalTurn,
  Timestamp,
  ToolDefinition,
  ToolIdempotencyStore,
  TtsStream,
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
import { IncrementalTtsInput } from "./incremental-tts-input.js";
import { deliverAssistantText } from "./text-delivery.js";
import { withSttReconnect } from "./resilient-stt.js";
import { getSttRecoveryControl } from "./resilient-stt.js";
import { appendConversationMemory } from "./conversation-memory.js";
import { assertMemoryPolicySupported } from "./memory-capabilities.js";
import type { SttCommandController } from "./stt-command-controller.js";
import { SerialSttCommandController } from "./stt-command-controller.js";
import { PipelineSttInput } from "./pipeline-stt-input.js";
import * as pipelineConstants from "./pipeline-constants.js";
import { createRememberFactTool } from "./remember-fact-tool.js";
import type { TextDeliveryMode } from "./text-delivery.js";
import { persistInterruptionCheckpoint } from "./persistence-policy.js";
import {
  cancellationReason,
  awaitTerminalTurn,
  isTerminalToolCall,
  linkAbortSignal,
  readTerminalTurn,
} from "./pipeline-helpers.js";
import { alignedTextForHistory, appendAlignedTokens } from "./turn-alignment.js";
import { reportTurnLatency } from "./turn-state.js";
import type {
  ActiveTurnControl,
  MutableTurnLatency,
  TurnLatencyRecord,
  UtteranceTiming,
} from "./turn-state.js";

const REDACTED_TOOL_INPUT = Object.freeze({
  $tvic: "input_unavailable",
  reason: "not_serializable",
});

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
  #memoryTool: ToolDefinition | undefined;
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
    this.#stallTimeoutMs = options.streamStallTimeoutMs ?? options.agent.timeoutPolicy.timeoutMs;
    this.#turnEndpointTimeoutMs =
      options.turnEndpointTimeoutMs ?? pipelineConstants.DEFAULT_TURN_ENDPOINT_TIMEOUT_MS;
    this.#turnMaxDurationMs =
      options.turnMaxDurationMs ?? pipelineConstants.DEFAULT_TURN_MAX_DURATION_MS;
    this.#onTimeout = options.agent.timeoutPolicy.onTimeout;
    this.#idempotency = options.runtime.toolIdempotencyStore ?? new InMemoryToolIdempotencyStore();
    this.#memoryTool = undefined;
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

  async run(): Promise<PipelineVoiceLoopResult> {
    const startupAbort = new AbortController();
    const detachStartupSignal = linkAbortSignal(this.#options.attachment?.signal, startupAbort);
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
        void opening.then((lateStream) => lateStream.close()).catch(() => undefined);
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
    const detachSupervisorSignal = linkAbortSignal(this.#options.attachment?.signal, supervisor);
    let sttError: unknown = null;
    let sttEnded = false;
    commandController.failure.catch((error) => {
      sttError ??= normalizeUnknownError(error, {
        code: "stt.command_failed",
        category: "internal",
        retriable: false,
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
      streamError = input.streamError;
      mediaEnded = input.mediaEnded;
    } catch (error) {
      endReason = "media_error";
      streamError = normalizeUnknownError(error, {
        code: "media.input_failed",
        category: "internal",
        retriable: false,
      });
      mediaEnded = true;
    }

    this.#shutdownReason =
      attachmentAbortReason(this.#options.attachment?.signal) ??
      (sttError ? "stt_error" : sttEnded ? "stt_ended" : endReason);

    const gracefulEnd = mediaEnded && endReason === "completed" && !sttError;
    if (gracefulEnd && !sttEnded) {
      const terminalFlush = this.#sttInput.commitAndFlush(stt, commandController);
      this.#sttInput.pendingCommitFlushes.add(terminalFlush);
      void terminalFlush
        .finally(() => this.#sttInput.pendingCommitFlushes.delete(terminalFlush))
        .catch(() => undefined);
      await Promise.allSettled(this.#sttInput.pendingCommitFlushes);
      await commandController.drain().catch(() => undefined);
    } else {
      // Caller/media shutdown preempts commit grace before stream close; otherwise
      // a late promise could flush a new turn after hangup.
      supervisor.abort(sttError ?? new Error("STT input ended"));
      await commandController
        .abort(sttError ?? new Error("STT input ended"))
        .catch(() => undefined);
    }

    this.#abortActive(this.#shutdownReason);
    this.#sttInput.cancelBargeInCandidate();
    await stt.close().catch(() => undefined);
    this.#removeRecoveryListener?.();
    this.#removeRecoveryListener = undefined;
    detachSupervisorSignal();
    try {
      await transcriptTask;
    } catch (error) {
      await this.#turnChain.catch(() => undefined);
      throw error;
    }
    await this.#turnChain;

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
    let terminalWriteMayBeLate = false;
    const detachControlSignal = linkAbortSignal(this.#options.attachment?.signal, control.abort);
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
    let finalText = "";
    let audioError: NormalizedError | null = null;
    let textDelivered: boolean | undefined;
    let incrementalFailure: unknown = null;
    let speakingPersisted = false;
    const toolCallIds: ToolCallId[] = [];
    const incrementalInput = this.#incrementalTtsInput(turn, control);
    const incrementalPlayback = incrementalInput
      ? incrementalInput.opened
          .then(async (opened) => {
            if (!opened) {
              control.outputDelivered = true;
              return;
            }
            await this.#playTtsStream(incrementalInput, control, latency);
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
      const first = await this.#runLlm(turn, messages, control, latency, onLlmText);
      finalText = first.text;

      if (!control.abort.signal.aborted && first.toolCalls.length > 0) {
        if (incrementalInput && !incrementalFailure) {
          await incrementalInput.flushBoundary().catch((error: unknown) => {
            incrementalFailure ??= error;
          });
        }
        await this.#persistTurnStatus(turn.id, "calling_tool");
        const tools = await this.#executeToolCalls(turn, first.toolCalls, control, latency);
        toolCallIds.push(...tools.toolCallIds);
        if (!control.abort.signal.aborted) {
          const continuation = await this.#runLlm(
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
            await this.#speak(this.#providers.tts, turn, finalText, control, latency);
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
          terminalWriteMayBeLate = error instanceof BackendUnavailableError;
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
      await this.#updateMemory(turn.id, transcript, finalText).catch(() => undefined);
      this.#recordTerminalTurn(terminal);
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
          await this.#updateMemory(turn.id, transcript, finalText).catch(() => undefined);
        }
        if (terminal) this.#recordTerminalTurn(terminal);
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

  async #runLlm(
    turn: Turn,
    messages: readonly LlmMessage[],
    control: ActiveTurnControl,
    latency: MutableTurnLatency,
    onText?: (text: string) => Promise<void>,
  ): Promise<{ readonly text: string; readonly toolCalls: readonly LlmInlineToolCall[] }> {
    let text = "";
    const toolCalls: LlmInlineToolCall[] = [];
    const seenToolRefs = new Set<string>();
    const toolList = this.#resolveToolList();
    const completion = await this.#raceStartup(
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
    );
    if (!completion) {
      return { text: "", toolCalls: [] };
    }

    const iterator = completion.events[Symbol.asyncIterator]();
    const aborted = abortPromise(control.abort.signal);
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
        await completion.cancel();
        if (this.#onTimeout === "interrupt") {
          this.#abortActive("timeout");
          break;
        }
        throw TvicThrowableError.from(
          timeoutError("llm.stalled", `LLM produced no event for ${this.#stallTimeoutMs}ms`),
        );
      }
      if (step.kind === "abort") {
        await completion.cancel();
        break;
      }
      if (step.result.done) {
        break;
      }

      const event = step.result.value;
      if (event.type === "llm.token") {
        if (control.abort.signal.aborted) break;
        latency.firstTokenMs ??= this.#durationSince(control.startedAtMs);
        text += event.text;
        await onText?.(event.text);
      } else if (event.type === "llm.tool_call") {
        toolCalls.push(event.call);
        seenToolRefs.add(event.call.callRef);
      } else if (event.type === "llm.completed") {
        if (control.abort.signal.aborted) break;
        if (!text && event.text) {
          text = event.text;
          await onText?.(event.text);
        }
        for (const call of event.toolCalls) {
          if (!seenToolRefs.has(call.callRef)) {
            toolCalls.push(call);
            seenToolRefs.add(call.callRef);
          }
        }
      } else if (event.type === "llm.failed") {
        await completion.cancel();
        throw TvicThrowableError.from(event.error);
      }
    }
    return { text: text.trim(), toolCalls };
  }

  async #executeToolCalls(
    turn: Turn,
    calls: readonly LlmInlineToolCall[],
    control: ActiveTurnControl,
    latency: MutableTurnLatency,
  ): Promise<{
    readonly messages: readonly LlmMessage[];
    readonly toolCallIds: readonly ToolCallId[];
  }> {
    const messages: LlmMessage[] = [];
    const toolCallIds: ToolCallId[] = [];

    for (const call of calls) {
      if (control.abort.signal.aborted) {
        break;
      }
      const tool =
        call.toolName === "remember_fact" ? this.#memoryTool : this.#policy.findTool(call);
      if (!tool) {
        const error = internalError(
          "tool.not_found",
          `No tool registered named ${String(call.toolName)}`,
        );
        messages.push({
          role: "tool",
          content: JSON.stringify({ error: { code: error.code, message: error.message } }),
          toolName: call.toolName,
          toolCallRef: call.callRef,
        });
        continue;
      }

      const toolCallId = this.#ids.toolCall();
      const startedAtMs = this.#monotonicMs();
      toolCallIds.push(toolCallId);
      const inputError = toolInputError(call.input, tool.inputSchema);
      const persistedInput = inputError ? REDACTED_TOOL_INPUT : call.input;
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
        result = await this.#recordToolCall({
          ...queued,
          status: "failed",
          startedAt: queued.queuedAt,
          endedAt: new Date().toISOString() as Timestamp,
          error: inputError,
          metadata: { inputRedacted: true },
        });
      } else {
        const running = await this.#startToolCall(queued);
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
        result = await this.#finishToolCall(result);
      }
      latency.toolMs = (latency.toolMs ?? 0) + this.#durationSince(startedAtMs);

      if (result.status === "succeeded") {
        messages.push({
          role: "tool",
          content: JSON.stringify(result.output),
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
          content: JSON.stringify({ error: { code: error.code, message: error.message } }),
          toolName: tool.name,
          toolCallRef: call.callRef,
        });
      }
    }
    return { messages, toolCallIds };
  }

  #incrementalTtsInput(turn: Turn, control: ActiveTurnControl): IncrementalTtsInput | null {
    const provider = this.#providers.tts;
    if (!provider || !isIncrementalTextToSpeechProvider(provider)) {
      return null;
    }
    return new IncrementalTtsInput({
      openSession: () =>
        provider.openSession({
          sessionId: this.#options.session.id,
          turnId: turn.id,
          ...(this.#options.ttsVoice ? { voice: this.#options.ttsVoice } : {}),
          ...(this.#options.ttsModel ? { model: this.#options.ttsModel } : {}),
          format: this.#options.agent.audioPolicy.output,
          timestamps: true,
          signal: control.abort.signal,
        }),
    });
  }

  async #speak(
    provider: TextToSpeechProvider,
    turn: Turn,
    text: string,
    control: ActiveTurnControl,
    latency: MutableTurnLatency,
  ): Promise<void> {
    if (!text) {
      control.outputDelivered = true;
      return;
    }

    const stream = await this.#raceStartup(
      provider.synthesize({
        sessionId: this.#options.session.id,
        turnId: turn.id,
        text,
        ...(this.#options.ttsVoice ? { voice: this.#options.ttsVoice } : {}),
        ...(this.#options.ttsModel ? { model: this.#options.ttsModel } : {}),
        format: this.#options.agent.audioPolicy.output,
        stream: true,
        signal: control.abort.signal,
      }),
      control.abort.signal,
      (handle) => handle.cancel(),
    );
    if (!stream) {
      return;
    }

    await this.#playTtsStream(stream, control, latency);
  }

  async #playTtsStream(
    stream: TtsStream,
    control: ActiveTurnControl,
    latency: MutableTurnLatency,
  ): Promise<void> {
    const iterator = stream.events[Symbol.asyncIterator]();
    const aborted = abortPromise(control.abort.signal);
    let committedMarkId: string | null = null;
    let audioDeadline = Date.now() + this.#stallTimeoutMs;
    while (true) {
      const stall = stallTimer(Math.max(0, audioDeadline - Date.now()));
      const next = iterator.next();
      next.catch(() => undefined);
      const step = await Promise.race([
        next.then((result) => ({ kind: "chunk" as const, result })),
        aborted.then(() => ({ kind: "abort" as const })),
        stall.promise.then(() => ({ kind: "timeout" as const })),
      ]);
      stall.cancel();

      if (step.kind === "timeout" && this.#onTimeout === "fail") {
        await stream.cancel();
        throw TvicThrowableError.from(
          timeoutError("tts.stalled", `TTS produced no audio for ${this.#stallTimeoutMs}ms`),
        );
      }
      if (step.kind === "abort" || step.kind === "timeout") {
        if (step.kind === "timeout") {
          this.#abortActive("timeout");
        }
        await stream.cancel();
        control.speaking = false;
        return;
      }
      if (step.result.done) {
        break;
      }

      const raw = step.result.value;
      if (raw.type === "tts.alignment") {
        if (control.alignedUnit !== raw.unit) {
          control.alignedTokens.length = 0;
          control.alignedCharacterStarts.clear();
          control.alignedUnit = raw.unit;
        }
        appendAlignedTokens(
          control.alignedTokens,
          raw.tokens,
          raw.unit,
          raw.startMs,
          control.alignedCharacterStarts,
        );
        control.alignedDurationMs = Math.max(control.alignedDurationMs, ...raw.endMs, 0);
        continue;
      }
      if (raw.type === "tts.flush.completed") {
        if (control.lastFlushSequence !== null && raw.sequence <= control.lastFlushSequence) {
          await stream.cancel();
          throw TvicThrowableError.from(
            internalError(
              "tts.flush_out_of_order",
              `TTS flush sequence ${raw.sequence} followed ${control.lastFlushSequence}`,
            ),
          );
        }
        control.lastFlushSequence = raw.sequence;
        continue;
      }
      const event =
        raw.type === "media.audio.chunk" ? { ...raw, monotonicOffsetMs: this.#monotonicMs() } : raw;
      if (control.abort.signal.aborted) {
        await stream.cancel();
        control.speaking = false;
        return;
      }
      const delivered = await this.#options.callHandle.send(event);
      const isCommit = event.type === "media.audio.committed";
      if (!delivered && (event.type === "media.audio.chunk" || isCommit)) {
        this.#abortActive("transport_closed");
        await stream.cancel();
        control.speaking = false;
        return;
      }
      if (isCommit) {
        committedMarkId = String(event.id);
      }
      if (event.type === "media.audio.chunk") {
        audioDeadline = Date.now() + this.#stallTimeoutMs;
        control.speaking = true;
        latency.firstAudioMs ??= this.#durationSince(control.startedAtMs);
        control.outputFramesSent += event.audio.frameCount;
      }
    }

    control.outputDelivered = await this.#confirmPlayout(committedMarkId, control);
    control.speaking = false;
  }

  async #confirmPlayout(markId: string | null, control: ActiveTurnControl): Promise<boolean> {
    const confirm = this.#options.callHandle.confirmPlayout;
    if (!confirm) {
      return true;
    }
    if (!markId) {
      return false;
    }
    const delivered = await Promise.race([
      confirm.call(this.#options.callHandle, markId, pipelineConstants.PLAYOUT_CONFIRM_TIMEOUT_MS),
      abortPromise(control.abort.signal).then(() => false),
    ]);
    return !control.abort.signal.aborted && delivered;
  }

  #resolveToolList(): readonly ToolDefinition[] {
    const configuredTools = this.#options.agent.tools.filter(
      (tool) => tool.name !== "remember_fact",
    );
    const policy = this.#options.agent.memoryPolicy;
    if (!policy.enabled || !policy.canLlmWrite || policy.readOnly) {
      this.#memoryTool = undefined;
      return configuredTools;
    }
    const memory = this.#memory;
    if (!memory) {
      this.#memoryTool = undefined;
      return configuredTools;
    }
    const tool = createRememberFactTool({
      memory,
      sessionId: this.#options.session.id,
      allowedScopes: policy.scopes,
      runMemoryOperation: (operation) => {
        const runtime = this.#options.runtime;
        return runtime.runSessionMemoryOperation
          ? runtime.runSessionMemoryOperation(this.#options.session.id, operation)
          : operation();
      },
      canWrite: async () => {
        if (this.#options.attachment?.signal.aborted) return false;
        const session = await this.#options.runtime
          .getSession(this.#options.session.id)
          .catch(() => null);
        return Boolean(session && !isTerminalSession(session));
      },
      ...(policy.maxBytesPerSession !== undefined
        ? { maxSessionBytes: policy.maxBytesPerSession }
        : {}),
      ...(this.#memoryUserId ? { userId: this.#memoryUserId } : {}),
      ...(this.#organizationId ? { organizationId: this.#organizationId } : {}),
      ...(this.#workflowId ? { workflowId: this.#workflowId } : {}),
    });
    this.#memoryTool = tool;
    return [...configuredTools, tool];
  }

  async #updateMemory(
    turnId: Turn["id"],
    transcript: string,
    assistantText: string,
    interrupted = false,
  ): Promise<void> {
    const memory = this.#memory;
    const policy = this.#options.agent.memoryPolicy;
    if (!memory || !policy.enabled || policy.readOnly) {
      return;
    }
    const write = async (): Promise<void> => {
      if (this.#options.attachment?.signal.aborted) return;
      const session = await this.#options.runtime
        .getSession(this.#options.session.id)
        .catch(() => null);
      if (!session || isTerminalSession(session) || this.#options.attachment?.signal.aborted)
        return;
      await appendConversationMemory({
        memory,
        policy,
        sessionId: this.#options.session.id,
        turnId,
        userId: this.#memoryUserId,
        ...(this.#organizationId ? { organizationId: this.#organizationId } : {}),
        ...(this.#workflowId ? { workflowId: this.#workflowId } : {}),
        transcript,
        assistantText,
        ...(interrupted ? { interrupted: true } : {}),
      });
    };
    const runtime = this.#options.runtime;
    if (runtime.runSessionMemoryOperation) {
      await runtime.runSessionMemoryOperation(this.#options.session.id, write);
      return;
    }
    await write();
  }

  async #raceStartup<T>(
    startup: Promise<T>,
    signal: AbortSignal,
    cancel: (handle: T) => Promise<void>,
  ): Promise<T | null> {
    const outcome = await Promise.race([
      startup.then((handle) => ({ aborted: false as const, handle })),
      abortPromise(signal).then(() => ({ aborted: true as const })),
    ]);
    if (!outcome.aborted) {
      return outcome.handle;
    }
    void startup.then((handle) => cancel(handle)).catch(() => undefined);
    return null;
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

function metadataString(
  metadata: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function attachmentAbortReason(signal: AbortSignal | undefined): string | null {
  if (!signal?.aborted) return null;
  const reason = signal.reason;
  if (reason && typeof reason === "object" && "code" in reason) {
    if ((reason as { readonly code?: unknown }).code === "LEASE_LOST") return "lease_lost";
  }
  return "transport_lost";
}
