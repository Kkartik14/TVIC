import { executeTool, InMemoryToolIdempotencyStore } from "@tvic/tools";
import {
  createDefaultIdGenerator,
  internalError,
  isIncrementalTextToSpeechProvider,
  isNormalizedError,
  timeoutError,
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
  Runtime,
  SttStream,
  TextToSpeechProvider,
  ToolCallId,
  TtsStream,
  Turn,
  UserId,
} from "@tvic/core";

import { reportAssistantText } from "./assistant-text.js";
import type { AssistantTextRecord } from "./assistant-text.js";
import { abortPromise, raceStartup, stallTimer, withTimeout } from "./async-control.js";
import { ConversationPolicy } from "./conversation-policy.js";
import { IncrementalTtsInput } from "./incremental-tts-input.js";
import { deliverAssistantText } from "./text-delivery.js";
import type { TextDeliveryMode } from "./text-delivery.js";
import { alignedTextForHistory, appendAlignedTokens } from "./turn-alignment.js";
import { reportTurnLatency } from "./turn-state.js";
import type {
  ActiveTurnControl,
  MutableTurnLatency,
  TurnLatencyRecord,
  UtteranceTiming,
} from "./turn-state.js";
import { SerialSttCommandController } from "./stt-command-controller.js";
import { getSttRecoveryControl, withSttReconnect } from "./resilient-stt.js";
import type { SttCommandController } from "./stt-command-controller.js";
import type { SttReconnectOptions } from "./resilient-stt.js";
import { PipelineSttInput } from "./pipeline-stt-input.js";
import * as pipelineConstants from "./pipeline-constants.js";
import { appendConversationMemory } from "./conversation-memory.js";

export type { TurnLatencyRecord } from "./turn-state.js";

export interface PipelineVoiceLoopOptions {
  readonly runtime: Runtime;
  readonly session: ActiveSession;
  readonly agent: Agent;
  readonly callHandle: CallHandle;
  readonly llmModel: string;
  readonly sttModel?: string;
  /** Allows a custom/self-hosted STT endpoint to accept a model outside TVIC's dated catalog. */
  readonly sttAllowUnknownModel?: boolean;
  readonly sttLanguage?: string;
  readonly sttReconnect?: boolean | SttReconnectOptions;
  readonly ttsVoice?: string;
  readonly ttsModel?: string;
  readonly idGenerator?: IdGenerator;
  readonly conversationPolicy?: ConversationPolicy;
  readonly memory?: Memory;
  readonly memoryUserId?: UserId;
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
  readonly #idempotency = new InMemoryToolIdempotencyStore();
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

  constructor(options: PipelineVoiceLoopOptions) {
    this.#options = options;
    this.#providers = options.agent.providers;
    this.#ids = options.idGenerator ?? createDefaultIdGenerator();
    this.#policy = options.conversationPolicy ?? new ConversationPolicy({ agent: options.agent });
    this.#stallTimeoutMs = options.streamStallTimeoutMs ?? options.agent.timeoutPolicy.timeoutMs;
    this.#turnEndpointTimeoutMs =
      options.turnEndpointTimeoutMs ?? pipelineConstants.DEFAULT_TURN_ENDPOINT_TIMEOUT_MS;
    this.#turnMaxDurationMs =
      options.turnMaxDurationMs ?? pipelineConstants.DEFAULT_TURN_MAX_DURATION_MS;
    this.#onTimeout = options.agent.timeoutPolicy.onTimeout;
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
    const sttProvider = this.#options.sttReconnect
      ? withSttReconnect(
          this.#providers.stt,
          typeof this.#options.sttReconnect === "boolean" ? {} : this.#options.sttReconnect,
        )
      : this.#providers.stt;
    let stt: SttStream;
    let opening: Promise<SttStream> | undefined;
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
      stt = await withTimeout(opening, pipelineConstants.STARTUP_TIMEOUT_MS);
    } catch (error) {
      startupAbort.abort();
      if (opening) {
        void opening.then((lateStream) => lateStream.close()).catch(() => undefined);
      }
      throw internalError(
        "stt.open_failed",
        error instanceof Error ? error.message : String(error),
      );
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
    let sttError: unknown = null;
    let sttEnded = false;
    commandController.failure.catch((error) => {
      sttError ??= isNormalizedError(error)
        ? error
        : internalError(
            "stt.command_failed",
            error instanceof Error ? error.message : String(error),
          );
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
      streamError = isNormalizedError(error)
        ? error
        : internalError(
            "media.input_failed",
            error instanceof Error ? error.message : String(error),
          );
      mediaEnded = true;
    }

    this.#shutdownReason = sttError ? "stt_error" : sttEnded ? "stt_ended" : endReason;

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
    try {
      await transcriptTask;
    } catch (error) {
      await this.#turnChain.catch(() => undefined);
      throw error;
    }
    await this.#turnChain;

    if (streamError) {
      throw streamError;
    }
    if (sttError) {
      throw isNormalizedError(sttError)
        ? sttError
        : internalError(
            "stt.failed",
            sttError instanceof Error ? sttError.message : String(sttError),
          );
    }
    if (!mediaEnded) {
      throw internalError(
        "stt.closed_unexpectedly",
        "STT stream ended before the caller's media did",
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
      control.cancelReason = reason;
      control.abort.abort();
    }
  }

  async #handleTranscript(transcript: string, timing: UtteranceTiming): Promise<void> {
    const turn = await this.#options.runtime.startTurn({
      sessionId: this.#options.session.id,
      input: { transcript, mediaEventIds: [] },
    });
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
    this.#active = control;
    if (this.#shutdownReason) {
      control.interruptedAtMs = this.#monotonicMs();
      control.cancelReason = this.#shutdownReason;
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
          if (incrementalFailure) return;
          await incrementalInput.pushToken(text).catch((error: unknown) => {
            incrementalFailure ??= error;
          });
        }
      : undefined;

    try {
      const messages = this.#policy.messagesForTranscript(transcript);
      const first = await this.#runLlm(turn, messages, control, latency, onLlmText);
      finalText = first.text;

      if (!control.abort.signal.aborted && first.toolCalls.length > 0) {
        if (incrementalInput && !incrementalFailure) {
          await incrementalInput.flushBoundary().catch((error: unknown) => {
            incrementalFailure ??= error;
          });
        }
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
            if (incrementalFailure) throw incrementalFailure;
            await incrementalInput.finish();
            await incrementalPlayback;
            if (incrementalFailure) throw incrementalFailure;
          } else if (this.#providers.tts) {
            await this.#speak(this.#providers.tts, turn, finalText, control, latency);
          }
          audioDelivered = control.outputDelivered;
        } else if (incrementalInput) {
          await incrementalInput.cancel();
          await incrementalPlayback?.catch(() => undefined);
        }
      } catch (error) {
        audioError = isNormalizedError(error)
          ? error
          : internalError(
              "tts.delivery_failed",
              error instanceof Error ? error.message : String(error),
            );
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
        await this.#options.runtime.endTurn(this.#options.session.id, turn.id, {
          reason: "cancelled",
          cancelReason: control.interruptedAtMs !== null ? control.cancelReason : "not_heard",
          output: { text: finalText, mediaEventIds: [] },
          toolCallIds,
          latency,
        });
        if (control.interruptedAtMs !== null && control.cancelReason === "barge_in") {
          const alignedText = control.alignedDurationMs > 0 ? alignedTextForHistory(control) : "";
          const interruptedText = alignedText || finalText;
          this.#policy.recordInterruptedTurn(transcript, interruptedText);
          await appendConversationMemory({
            memory: this.#options.memory,
            policy: this.#options.agent.memoryPolicy,
            sessionId: this.#options.session.id,
            userId: this.#options.memoryUserId,
            transcript,
            assistantText: interruptedText,
            interrupted: true,
          }).catch(() => undefined);
        }
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

      await this.#options.runtime.endTurn(this.#options.session.id, turn.id, {
        reason: "completed",
        output: { text: finalText, mediaEventIds: [] },
        toolCallIds,
        latency,
      });
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
      await appendConversationMemory({
        memory: this.#options.memory,
        policy: this.#options.agent.memoryPolicy,
        sessionId: this.#options.session.id,
        userId: this.#options.memoryUserId,
        transcript,
        assistantText: finalText,
      }).catch(() => undefined);
    } catch (error) {
      latency.totalMs = this.#durationSince(startedAtMs);
      const turnError = isNormalizedError(error)
        ? error
        : internalError("turn.failed", error instanceof Error ? error.message : String(error));
      this.#turnsFailed += 1;
      this.#firstTurnError ??= turnError;
      await this.#options.runtime
        .endTurn(this.#options.session.id, turn.id, {
          reason: "failed",
          error: turnError,
          output: { text: finalText, mediaEventIds: [] },
          toolCallIds,
          latency,
        })
        .catch(() => undefined);
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
    } finally {
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
    const completion = await raceStartup(
      this.#providers.llm.complete({
        sessionId: this.#options.session.id,
        turnId: turn.id,
        model: this.#options.llmModel,
        messages,
        tools: this.#options.agent.tools,
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
        throw timeoutError("llm.stalled", `LLM produced no event for ${this.#stallTimeoutMs}ms`);
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
        latency.firstTokenMs ??= this.#durationSince(control.startedAtMs);
        text += event.text;
        await onText?.(event.text);
      } else if (event.type === "llm.tool_call") {
        toolCalls.push(event.call);
        seenToolRefs.add(event.call.callRef);
      } else if (event.type === "llm.completed") {
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
        throw event.error;
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
      const tool = this.#policy.findTool(call);
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
      const result = await executeTool({
        tool,
        input: call.input,
        sessionId: this.#options.session.id,
        turnId: turn.id,
        toolCallId,
        signal: control.abort.signal,
        idempotencyStore: this.#idempotency,
      });
      await this.#options.runtime.recordToolCall(result);
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

    const stream = await raceStartup(
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
        throw timeoutError("tts.stalled", `TTS produced no audio for ${this.#stallTimeoutMs}ms`);
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
          throw internalError(
            "tts.flush_out_of_order",
            `TTS flush sequence ${raw.sequence} followed ${control.lastFlushSequence}`,
          );
        }
        control.lastFlushSequence = raw.sequence;
        continue;
      }
      const event =
        raw.type === "media.audio.chunk" ? { ...raw, monotonicOffsetMs: this.#monotonicMs() } : raw;
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
    return Promise.race([
      confirm.call(this.#options.callHandle, markId, pipelineConstants.PLAYOUT_CONFIRM_TIMEOUT_MS),
      abortPromise(control.abort.signal).then(() => false),
    ]);
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
