import { isInputMediaEvent } from "@tvic/media";
import { executeTool, InMemoryToolIdempotencyStore } from "@tvic/tools";
import {
  audioOutputChunkTrace,
  audioOutputEndedTrace,
  audioOutputStartedTrace,
  bargeInRejectedTrace,
  interruptDetectedTrace,
  interruptHandledTrace,
  llmStreamTrace,
  memoryWriteTrace,
  outputCancelledTrace,
  runtimeRetryTrace,
  runtimeTimeoutTrace,
  sttFinalTrace,
  toolCancelledTrace,
  toolCompletedTrace,
  toolFailedTrace,
  toolNotFoundTrace,
  toolQueuedTrace,
  toolStartedTrace,
  traceCore,
  ttsChunkTrace,
  ttsCompletedTrace,
  ttsStartedTrace,
} from "@tvic/tracing";

import {
  createDefaultIdGenerator,
  createSystemClock,
  internalError,
  isNormalizedError,
  timeoutError,
} from "@tvic/core";
import type {
  ActiveSession,
  Agent,
  CallHandle,
  Clock,
  CorrelationId,
  IdGenerator,
  LLMProvider,
  LlmInlineToolCall,
  LlmMessage,
  Memory,
  MemoryRef,
  NormalizedError,
  Runtime,
  SpanId,
  SpeechToTextProvider,
  SttStream,
  TextToSpeechProvider,
  ToolCallId,
  TraceEvent,
  TranscriptEvent,
  Turn,
} from "@tvic/core";

import { ConversationPolicy } from "./conversation-policy.js";

export interface PipelineVoiceLoopOptions {
  readonly runtime: Runtime;
  readonly session: ActiveSession;
  readonly agent: Agent;
  readonly callHandle: CallHandle;
  readonly stt: SpeechToTextProvider;
  readonly llm: LLMProvider;
  readonly tts: TextToSpeechProvider;
  readonly llmModel: string;
  readonly sttLanguage?: string;
  readonly ttsVoice?: string;
  readonly ttsModel?: string;
  readonly clock?: Clock;
  readonly idGenerator?: IdGenerator;
  readonly conversationPolicy?: ConversationPolicy;
  readonly memory?: Memory;
  /** Max ms a provider stream may stall (no events) before the turn fails. */
  readonly streamStallTimeoutMs?: number;
}

export interface PipelineVoiceLoopResult {
  readonly session: ActiveSession;
  readonly turnsHandled: number;
  readonly interruptions: number;
  /** Turns that reached the `failed` terminal state. A run can return with these > 0. */
  readonly turnsFailed: number;
  /** The first turn failure, so the caller can classify an otherwise-finished call. */
  readonly firstTurnError: NormalizedError | null;
}

interface MutableTurnLatency {
  firstTokenMs?: number;
  firstAudioMs?: number;
  toolMs?: number;
  totalMs?: number;
}

interface ActiveTurnControl {
  readonly turnId: Turn["id"];
  readonly abort: AbortController;
  readonly parentSpanId: SpanId;
  readonly correlationId: CorrelationId;
  readonly startedAtMs: number;
  interruptedAtMs: number | null;
  cancelReason: string;
  outputFramesSent: number;
  /** True only while TTS audio is being streamed to the channel. */
  speaking: boolean;
  /**
   * True once the agent's response was fully delivered (TTS drained + heard, or there
   * was nothing to speak). An abort that arrives after this — e.g. the caller hangs up
   * having already heard the reply — does not retroactively cancel the turn.
   */
  outputDelivered: boolean;
}

/**
 * The realtime orchestration loop for pipeline-mode agents:
 * incoming audio -> streaming STT -> conversation policy -> LLM -> tools ->
 * streaming TTS -> outgoing audio. Interruptions, latency metrics, trace spans,
 * and memory updates are produced as the conversation runs.
 */
export class PipelineVoiceLoop {
  readonly #options: PipelineVoiceLoopOptions;
  readonly #ids: IdGenerator;
  readonly #clock: Clock;
  readonly #policy: ConversationPolicy;
  #turnsHandled = 0;
  #turnsFailed = 0;
  #firstTurnError: NormalizedError | null = null;
  #interruptions = 0;
  #turnChain: Promise<void> = Promise.resolve();
  #active: ActiveTurnControl | null = null;
  // Per-call idempotency cache so a tool's idempotency policy is honoured across the
  // turns of one conversation.
  readonly #idempotency = new InMemoryToolIdempotencyStore();
  readonly #stallTimeoutMs: number;
  readonly #onTimeout: "fail" | "interrupt";

  constructor(options: PipelineVoiceLoopOptions) {
    this.#options = options;
    this.#ids = options.idGenerator ?? createDefaultIdGenerator();
    this.#clock = options.clock ?? createSystemClock();
    this.#policy = options.conversationPolicy ?? new ConversationPolicy({ agent: options.agent });
    // The agent's per-operation timeout policy drives the provider stall guard
    // (override the duration per-call with streamStallTimeoutMs).
    this.#stallTimeoutMs = options.streamStallTimeoutMs ?? options.agent.timeoutPolicy.timeoutMs;
    this.#onTimeout = options.agent.timeoutPolicy.onTimeout;
  }

  async run(): Promise<PipelineVoiceLoopResult> {
    // STT open is raced against a startup timeout — like LLM/TTS startup — so a stalled
    // connect fails the call fast instead of wedging it before supervision begins. The
    // signal lets a well-behaved provider cancel its in-flight connect on timeout.
    const startupAbort = new AbortController();
    let stt: SttStream;
    try {
      stt = await withTimeout(
        this.#options.stt.open({
          sessionId: this.#options.session.id,
          format: this.#options.agent.audioPolicy.input,
          ...(this.#options.sttLanguage ? { language: this.#options.sttLanguage } : {}),
          interimResults: true,
          vocabulary: this.#options.agent.tools.map((tool) => String(tool.name)),
          signal: startupAbort.signal,
        }),
        STARTUP_TIMEOUT_MS,
      );
    } catch (error) {
      startupAbort.abort(); // cancel a provider that resolves later, so it can't leak
      throw internalError(
        "stt.open_failed",
        error instanceof Error ? error.message : String(error),
      );
    }

    // The transcript stream (STT) and the call's input media stream are independent
    // failure domains. Supervise them together: if STT ends — whether it fails OR
    // closes cleanly — stop consuming input at once. Otherwise a dead STT would leave
    // the loop ingesting caller audio forever with no transcripts.
    const supervisor = new AbortController();
    let sttError: unknown = null;
    let sttEnded = false;
    const transcriptTask = this.#consumeTranscripts(stt.events);
    // Observe (don't consume) the settlement so a rejection can't go unhandled; the
    // error is re-thrown from the drain below. In the happy path this fires only after
    // we close STT (post-consume), so the abort is a no-op.
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
      const input = await this.#consumeInput(stt, supervisor.signal);
      endReason = input.endReason;
      streamError = input.streamError;
      mediaEnded = input.mediaEnded;
    } catch (error) {
      // The input transport itself threw mid-call.
      endReason = "media_error";
      streamError = internalError(
        "media.input_failed",
        error instanceof Error ? error.message : String(error),
      );
      mediaEnded = true;
    }

    // Input has stopped — explicit end/error event, transport close (a raw socket
    // drop emits no event, only ends the iterator), or STT ending. The caller can no
    // longer hear us, so abort any in-flight turn before draining so generation never
    // outlives the call. A fully delivered response is unaffected (see
    // ActiveTurnControl.outputDelivered).
    this.#abortActive(sttError ? "stt_error" : sttEnded ? "stt_ended" : endReason);
    await stt.close().catch(() => undefined);

    // Strict drain order so no late final transcript is dropped: STT is now closed
    // (its event stream ends) — consume every remaining transcript (each enqueues its
    // turn), THEN await the now-final turn chain.
    try {
      await transcriptTask;
    } catch (error) {
      await this.#turnChain.catch(() => undefined);
      throw error;
    }
    await this.#turnChain;

    if (streamError) {
      // A media transport / STT error fails the session — never a successful result.
      throw streamError;
    }
    if (!mediaEnded) {
      // The loop stopped because STT ended while the caller was still connected — a
      // provider disappearing mid-call is a failure, not a successful call.
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

  /**
   * Drains the call's input media stream into STT, applying barge-in. Each pull races
   * the supervisor signal so an STT failure stops input consumption promptly instead
   * of blocking on the next caller frame.
   */
  async #consumeInput(
    stt: SttStream,
    signal: AbortSignal,
  ): Promise<{
    readonly endReason: string;
    readonly streamError: NormalizedError | null;
    readonly mediaEnded: boolean;
  }> {
    let endReason = "remote_hangup";
    let streamError: NormalizedError | null = null;
    let mediaEnded = false;
    const iterator = this.#options.callHandle.events[Symbol.asyncIterator]();
    const aborted = abortPromise(signal);

    try {
      while (!signal.aborted) {
        const next = iterator.next();
        // The discarded pull (when the supervisor wins the race) may settle later;
        // swallow it so a late rejection can't surface as unhandled.
        next.catch(() => undefined);
        const step = await Promise.race([
          next.then((result) => ({ kind: "event" as const, result })),
          aborted.then(() => ({ kind: "aborted" as const })),
        ]);
        if (step.kind === "aborted") {
          break;
        }
        if (step.result.done) {
          // The transport closed (a raw socket drop) — the caller is gone.
          mediaEnded = true;
          break;
        }
        const event = step.result.value;
        if (!isInputMediaEvent(event)) {
          continue;
        }

        await this.#options.runtime.injectMediaEvent(event);

        if (event.type === "media.audio.chunk") {
          await stt.sendAudio(event);
        }

        // A media-plane barge-in interrupts only audible output — the same
        // output-active gating as STT partials — so an early VAD false positive
        // can't cancel a turn before any audio has played.
        if (event.type === "barge_in.detected" && this.#active?.speaking) {
          await this.#interrupt("barge_in", event.confidence);
        }

        if (event.type === "media.stream.ended" || event.type === "media.error") {
          mediaEnded = true;
          if (event.type === "media.error") {
            endReason = "media_error";
            streamError = event.error;
          }
          break;
        }
      }
    } finally {
      if (iterator.return) {
        await iterator.return().catch(() => undefined);
      }
    }

    return { endReason, streamError, mediaEnded };
  }

  /** Aborts the in-flight turn (e.g. caller hangup) so generation stops and the turn ends cancelled. */
  #abortActive(reason: string): void {
    const control = this.#active;
    if (control && control.interruptedAtMs === null) {
      control.interruptedAtMs = this.#monotonicMs();
      control.cancelReason = reason;
      control.abort.abort();
    }
  }

  async #consumeTranscripts(events: AsyncIterable<TranscriptEvent>): Promise<void> {
    for await (const event of events) {
      // Caller speech (an interim or final transcript) arriving while the agent is
      // actually speaking IS the barge-in signal — STT is our VAD here. Gated on
      // output-active so we don't interrupt during LLM/tool work before any audio
      // plays. The first such event interrupts; #interrupt is idempotent per turn.
      if (this.#active?.speaking && event.text.trim().length > 0) {
        await this.#interrupt("barge_in", event.confidence ?? 1);
      }

      const transcript = this.#policy.acceptTranscript(event);
      if (!transcript) {
        continue;
      }

      this.#turnChain = this.#turnChain.then(() => this.#handleTranscript(transcript, event));
    }
  }

  async #handleTranscript(transcript: string, transcriptEvent: TranscriptEvent): Promise<void> {
    const turn = await this.#options.runtime.startTurn({
      sessionId: this.#options.session.id,
      input: { transcript, mediaEventIds: [] },
    });
    this.#turnsHandled += 1;

    const parentSpanId = this.#ids.span();
    const correlationId = this.#ids.correlation();
    const eouAtMs = this.#monotonicMs();
    const control: ActiveTurnControl = {
      turnId: turn.id,
      abort: new AbortController(),
      parentSpanId,
      correlationId,
      startedAtMs: eouAtMs,
      interruptedAtMs: null,
      cancelReason: "barge_in",
      outputFramesSent: 0,
      speaking: false,
      outputDelivered: false,
    };
    this.#active = control;
    const latency: MutableTurnLatency = {};

    let finalText = "";
    const toolCallIds: ToolCallId[] = [];

    try {
      await this.#emitSttFinal(turn, transcript, transcriptEvent, parentSpanId, correlationId);

      const messages = this.#policy.messagesForTranscript(transcript);
      const first = await this.#runLlm(turn, messages, parentSpanId, control, latency);
      finalText = first.text;

      if (!control.abort.signal.aborted && first.toolCalls.length > 0) {
        const tools = await this.#executeToolCalls(
          turn,
          first.toolCalls,
          parentSpanId,
          control,
          latency,
        );
        toolCallIds.push(...tools.toolCallIds);
        if (!control.abort.signal.aborted) {
          const continuation = await this.#runLlm(
            turn,
            this.#policy.messagesForToolContinuation(messages, first.text, tools.messages),
            parentSpanId,
            control,
            latency,
          );
          finalText = continuation.text;
        }
      }

      if (!control.abort.signal.aborted) {
        await this.#speak(turn, finalText, parentSpanId, control, latency);
      }

      latency.totalMs = this.#durationSince(eouAtMs);

      // A turn is completed only if its reply was actually delivered to the caller
      // (heard, per playout confirmation). Anything else is cancelled and is never
      // recorded to conversation memory.
      if (!control.outputDelivered) {
        // A genuine interruption (barge-in / hangup / transport drop mid-playout)
        // emits interrupt.handled; a reply that simply went unheard (e.g. hangup
        // during playout, no barge-in) is cancelled as "not_heard".
        if (control.interruptedAtMs !== null) {
          await this.#emit(
            interruptHandledTrace(
              this.#traceCore(this.#ids.span(), correlationId, parentSpanId),
              turn.id,
              this.#durationSince(control.interruptedAtMs),
              control.outputFramesSent > 0,
            ),
          );
        }
        await this.#options.runtime.endTurn(this.#options.session.id, turn.id, {
          reason: "cancelled",
          cancelReason: control.interruptedAtMs !== null ? control.cancelReason : "not_heard",
          output: { text: finalText, mediaEventIds: [] },
          toolCallIds,
          latency,
        });
        return;
      }

      await this.#options.runtime.endTurn(this.#options.session.id, turn.id, {
        reason: "completed",
        output: { text: finalText, mediaEventIds: [] },
        toolCallIds,
        latency,
      });
      this.#policy.recordTurn(transcript, finalText);
      await this.#updateMemory(transcript, finalText, parentSpanId, correlationId);
    } catch (error) {
      // A turn must always reach a terminal state. A single failed turn fails the
      // turn (not the call) so the conversation can continue — but it is counted and
      // surfaced in the result so the call is never silently reported as clean.
      latency.totalMs = this.#durationSince(eouAtMs);
      // Preserve a provider/tool NormalizedError (code + category); only wrap raw throws.
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
        .catch(() => undefined); // already failing — never throw out of the turn chain
    } finally {
      this.#active = null;
    }
  }

  async #interrupt(
    cause: "barge_in" | "dtmf" | "explicit" | "timeout",
    confidence: number,
  ): Promise<void> {
    const control = this.#active;
    if (!control || control.interruptedAtMs !== null) {
      return;
    }

    // Interruption mode is a runtime policy. `minSpeechMs` / echo-floor / STT
    // confirmation are enforced upstream in the media plane (VAD). Callers only reach
    // here while the agent is audibly speaking (output-active gating), so a barge-in
    // truncates real playout — never a turn that has not produced audio yet. Here we
    // only honour whether the agent accepts interruptions at all.
    if (this.#options.agent.interruptionPolicy.mode === "ignore") {
      await this.#emit(
        bargeInRejectedTrace(
          this.#traceCore(this.#ids.span(), control.correlationId, control.parentSpanId),
          control.turnId,
          confidence,
          "policy_ignored",
        ),
      );
      return;
    }

    control.interruptedAtMs = this.#monotonicMs();
    this.#interruptions += 1;
    // Abort first so in-flight LLM/TTS stop immediately; a slow telephony clear
    // must never delay cancellation of generation.
    control.abort.abort();
    await this.#emit(
      interruptDetectedTrace(
        this.#traceCore(this.#ids.span(), control.correlationId, control.parentSpanId),
        control.turnId,
        cause,
      ),
    );
    if (this.#options.agent.interruptionPolicy.cancelOutputOnInterrupt) {
      await this.#clearOutput(cause, control);
    }
  }

  /** Telephony clear is best-effort and bounded: it can never block or throw the loop. */
  async #clearOutput(
    cause: "barge_in" | "dtmf" | "explicit" | "timeout",
    control: ActiveTurnControl,
  ): Promise<void> {
    try {
      await withTimeout(this.#options.callHandle.cancelOutput(cause), CLEAR_TIMEOUT_MS);
    } catch {
      await this.#emit(
        runtimeTimeoutTrace(
          this.#traceCore(this.#ids.span(), control.correlationId, control.parentSpanId),
          "telephony.clear",
          CLEAR_TIMEOUT_MS,
        ),
      );
    }
  }

  async #runLlm(
    turn: Turn,
    messages: readonly LlmMessage[],
    parentSpanId: SpanId,
    control: ActiveTurnControl,
    latency: MutableTurnLatency,
  ): Promise<{ readonly text: string; readonly toolCalls: readonly LlmInlineToolCall[] }> {
    const spanId = this.#ids.span();
    const correlationId = this.#ids.correlation();
    const startedAtMs = this.#monotonicMs();
    let text = "";
    const toolCalls: LlmInlineToolCall[] = [];
    const seenToolRefs = new Set<string>();

    // Provider startup must be abortable too: a barge-in during connection
    // setup (e.g. a TTS/LLM socket opening) must not stall the turn.
    const completion = await this.#raceStartup(
      this.#options.llm.complete({
        sessionId: this.#options.session.id,
        turnId: turn.id,
        model: this.#options.llmModel,
        messages,
        tools: this.#options.agent.tools,
        stream: true,
        temperature: 0.2,
        signal: control.abort.signal,
      }),
      control.abort.signal,
      (handle) => handle.cancel(),
    );
    if (!completion) {
      return { text: "", toolCalls: [] };
    }

    // Race each event against abort (barge-in) and a stall timeout, so a provider that
    // accepts the request then never streams can't leave the caller in dead air.
    const iterator = completion.events[Symbol.asyncIterator]();
    const aborted = abortPromise(control.abort.signal);

    while (true) {
      const stall = stallTimer(this.#stallTimeoutMs);
      const step = await Promise.race([
        iterator.next().then((result) => ({ kind: "event" as const, result })),
        aborted.then(() => ({ kind: "abort" as const })),
        stall.promise.then(() => ({ kind: "timeout" as const })),
      ]);
      stall.cancel();

      if (step.kind === "timeout") {
        await completion.cancel();
        if (this.#onTimeout === "interrupt") {
          // Stop trying and let the turn end cancelled; the call continues.
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

      const trace = llmStreamTrace(
        this.#traceCore(spanId, correlationId, parentSpanId),
        event,
        this.#options.llmModel,
        this.#durationSince(startedAtMs),
      );
      if (trace) {
        await this.#emit(trace);
      }
      if (event.type === "llm.token") {
        if (latency.firstTokenMs === undefined) {
          latency.firstTokenMs = this.#durationSince(control.startedAtMs);
        }
        text += event.text;
      }
      if (event.type === "llm.tool_call") {
        toolCalls.push(event.call);
        seenToolRefs.add(event.call.callRef);
      }
      if (event.type === "llm.completed") {
        if (!text) {
          text = event.text;
        }
        // Some providers deliver tool calls only on the completed event. Honour them,
        // de-duped against any already streamed so none is executed twice.
        for (const call of event.toolCalls) {
          if (!seenToolRefs.has(call.callRef)) {
            toolCalls.push(call);
            seenToolRefs.add(call.callRef);
          }
        }
      }
      if (event.type === "llm.failed") {
        // A provider failure must fail the turn — never become an empty success.
        await completion.cancel();
        throw event.error;
      }
    }

    return { text: text.trim(), toolCalls };
  }

  async #executeToolCalls(
    turn: Turn,
    calls: readonly LlmInlineToolCall[],
    parentSpanId: SpanId,
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
        // Model hallucinated a tool that doesn't exist. Surface it and tell the model,
        // rather than silently dropping the call.
        const error = internalError(
          "tool.not_found",
          `No tool registered named ${String(call.toolName)}`,
        );
        await this.#emit(
          toolNotFoundTrace(
            this.#traceCore(this.#ids.span(), this.#ids.correlation(), parentSpanId),
            call.toolName,
            this.#ids.toolCall(),
            turn.id,
            error,
          ),
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
      const spanId = this.#ids.span();
      const correlationId = this.#ids.correlation();
      const startedAtMs = this.#monotonicMs();
      toolCallIds.push(toolCallId);

      await this.#emit(
        toolQueuedTrace(
          this.#traceCore(spanId, correlationId, parentSpanId),
          tool,
          toolCallId,
          turn.id,
        ),
      );
      await this.#emit(
        toolStartedTrace(
          this.#traceCore(spanId, correlationId, parentSpanId),
          tool,
          toolCallId,
          turn.id,
        ),
      );

      const result = await executeTool({
        tool,
        input: call.input,
        sessionId: this.#options.session.id,
        turnId: turn.id,
        toolCallId,
        signal: control.abort.signal,
        idempotencyStore: this.#idempotency,
        onRetry: async (info) => {
          await this.#emit(
            runtimeRetryTrace(
              this.#traceCore(this.#ids.span(), correlationId, parentSpanId),
              `tool:${String(tool.name)}`,
              info.attempt,
              info.delayMs,
              info.cause,
            ),
          );
        },
      });
      // Persist the full ToolCall (input/output/error) so it is replayable.
      await this.#options.runtime.recordToolCall(result);
      const durationMs = this.#durationSince(startedAtMs);
      latency.toolMs = (latency.toolMs ?? 0) + durationMs;

      if (result.status === "succeeded") {
        await this.#emit(
          toolCompletedTrace(
            this.#traceCore(spanId, correlationId, parentSpanId),
            tool,
            toolCallId,
            turn.id,
            result.attempts,
            durationMs,
          ),
        );
        messages.push({
          role: "tool",
          content: JSON.stringify(result.output),
          toolName: tool.name,
          toolCallRef: call.callRef,
        });
      } else if (result.status === "cancelled") {
        await this.#emit(
          toolCancelledTrace(
            this.#traceCore(spanId, correlationId, parentSpanId),
            tool,
            toolCallId,
            turn.id,
            result.attempts,
            durationMs,
            "barge_in",
          ),
        );
        break;
      } else {
        await this.#emit(
          toolFailedTrace(
            this.#traceCore(spanId, correlationId, parentSpanId),
            tool,
            toolCallId,
            turn.id,
            result.status === "timed_out" ? "tool.timed_out" : "tool.failed",
            result.attempts,
            durationMs,
            "error" in result ? result.error : internalError("tool.failed", "Tool failed"),
          ),
        );
        // Feed the failure back to the model so it can recover (e.g. apologise or try
        // an alternative) instead of the LLM silently believing the tool succeeded.
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

  async #speak(
    turn: Turn,
    text: string,
    parentSpanId: SpanId,
    control: ActiveTurnControl,
    latency: MutableTurnLatency,
  ): Promise<void> {
    if (!text) {
      // No audio to deliver — the turn still finished its work.
      control.outputDelivered = true;
      return;
    }

    const ttsSpanId = this.#ids.span();
    const audioSpanId = this.#ids.span();
    const correlationId = this.#ids.correlation();
    const startedAtMs = this.#monotonicMs();
    let totalFrames = 0;
    let playedMs = 0;
    let committedMarkId: string | null = null;

    await this.#emit(
      ttsStartedTrace(
        this.#traceCore(ttsSpanId, correlationId, parentSpanId),
        turn.id,
        this.#options.ttsVoice,
      ),
    );
    await this.#emit(
      audioOutputStartedTrace(this.#traceCore(audioSpanId, correlationId, parentSpanId), turn.id),
    );

    const stream = await this.#raceStartup(
      this.#options.tts.synthesize({
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
      // Barge-in during TTS connection setup: nothing was played.
      await this.#emit(
        outputCancelledTrace(
          this.#traceCore(this.#ids.span(), correlationId, parentSpanId),
          turn.id,
          0,
          this.#durationSince(startedAtMs),
        ),
      );
      await this.#emit(
        audioOutputEndedTrace(
          this.#traceCore(audioSpanId, correlationId, parentSpanId),
          turn.id,
          0,
          "cancelled",
        ),
      );
      return;
    }

    // Race each chunk against abort (barge-in) and a stall timeout, so a TTS stream
    // that connects then never sends bytes can't strand the turn in dead air.
    const iterator = stream.events[Symbol.asyncIterator]();
    const aborted = abortPromise(control.abort.signal);

    while (true) {
      const stall = stallTimer(this.#stallTimeoutMs);
      const step = await Promise.race([
        iterator.next().then((result) => ({ kind: "chunk" as const, result })),
        aborted.then(() => ({ kind: "abort" as const })),
        stall.promise.then(() => ({ kind: "timeout" as const })),
      ]);
      stall.cancel();

      if (step.kind === "timeout" && this.#onTimeout === "fail") {
        await stream.cancel();
        throw timeoutError("tts.stalled", `TTS produced no audio for ${this.#stallTimeoutMs}ms`);
      }
      if (step.kind === "abort" || step.kind === "timeout") {
        // abort = barge-in; timeout (interrupt mode) = give up on a stalled TTS.
        // Either way: stop playout and end the turn cancelled, the call continues.
        if (step.kind === "timeout") {
          this.#abortActive("timeout");
        }
        await stream.cancel();
        await this.#emit(
          outputCancelledTrace(
            this.#traceCore(this.#ids.span(), correlationId, parentSpanId),
            turn.id,
            control.outputFramesSent,
            this.#durationSince(startedAtMs),
          ),
        );
        await this.#emit(
          audioOutputEndedTrace(
            this.#traceCore(audioSpanId, correlationId, parentSpanId),
            turn.id,
            playedMs,
            "cancelled",
          ),
        );
        control.speaking = false;
        return;
      }

      if (step.result.done) {
        break;
      }
      const raw = step.result.value;
      // Re-stamp output audio with the session monotonic clock at send time. TTS
      // providers don't know call time (Cartesia emits 0), so this is what makes
      // persisted output audio align to the call timeline for replay.
      const event =
        raw.type === "media.audio.chunk" ? { ...raw, monotonicOffsetMs: this.#monotonicMs() } : raw;

      const delivered = await this.#options.callHandle.send(event);
      const isCommit = event.type === "media.audio.committed";
      if (!delivered && (event.type === "media.audio.chunk" || isCommit)) {
        // The transport dropped a critical frame — an audio chunk or the commit mark
        // we confirm playout against. Either way the caller can't have heard the full
        // reply, so treat it as caller-gone: cancel/unheard, never a delivered reply.
        this.#abortActive("transport_closed");
        await stream.cancel();
        await this.#emit(
          outputCancelledTrace(
            this.#traceCore(this.#ids.span(), correlationId, parentSpanId),
            turn.id,
            control.outputFramesSent,
            this.#durationSince(startedAtMs),
          ),
        );
        await this.#emit(
          audioOutputEndedTrace(
            this.#traceCore(audioSpanId, correlationId, parentSpanId),
            turn.id,
            playedMs,
            "cancelled",
          ),
        );
        control.speaking = false;
        return;
      }
      if (isCommit) {
        committedMarkId = String(event.id); // the (delivered) mark we confirm playout against
      }
      if (event.type === "media.audio.chunk") {
        // Only now is the agent actually audible — barge-in becomes possible here,
        // never during TTS connection/TTFB before any audio has been sent.
        control.speaking = true;
        if (latency.firstAudioMs === undefined) {
          latency.firstAudioMs = this.#durationSince(control.startedAtMs);
        }
        totalFrames += event.audio.frameCount;
        playedMs += event.audio.durationMs;
        control.outputFramesSent += event.audio.frameCount;
        await this.#emit(
          ttsChunkTrace(
            this.#traceCore(ttsSpanId, correlationId, parentSpanId),
            turn.id,
            event.id,
            event.audio.frameCount,
            event.audio.durationMs,
          ),
        );
        await this.#emit(
          audioOutputChunkTrace(
            this.#traceCore(audioSpanId, correlationId, parentSpanId),
            turn.id,
            event.id,
            event.audio.frameCount,
            event.audio.durationMs,
          ),
        );
      }
    }

    await this.#emit(
      ttsCompletedTrace(
        this.#traceCore(ttsSpanId, correlationId, parentSpanId),
        turn.id,
        this.#durationSince(startedAtMs),
        totalFrames,
      ),
    );

    // Synthesis finished and all frames reached the transport. Confirm the caller
    // actually heard it (mark ack) before marking the reply delivered — a hangup
    // during playout must not record a completed, remembered answer.
    const heard = await this.#confirmPlayout(committedMarkId, control);
    await this.#emit(
      audioOutputEndedTrace(
        this.#traceCore(audioSpanId, correlationId, parentSpanId),
        turn.id,
        playedMs,
        heard ? undefined : "cancelled",
      ),
    );
    control.speaking = false;
    control.outputDelivered = heard;
  }

  /**
   * Confirms the caller actually heard the marked output. Resolves false if the call
   * drops (or the caller barges in) during playout.
   *
   * - No `confirmPlayout` on the transport (e.g. simulated): can't observe playout, so
   *   fall back to "reached transport" = true.
   * - A confirming transport (e.g. Twilio) with NO commit mark: there is nothing to
   *   confirm, so the reply is unheard (false) — never silently completed.
   */
  async #confirmPlayout(markId: string | null, control: ActiveTurnControl): Promise<boolean> {
    const confirm = this.#options.callHandle.confirmPlayout;
    if (!confirm) {
      return true;
    }
    if (!markId) {
      return false;
    }
    return Promise.race([
      confirm.call(this.#options.callHandle, markId, PLAYOUT_CONFIRM_TIMEOUT_MS),
      abortPromise(control.abort.signal).then(() => false),
    ]);
  }

  async #updateMemory(
    transcript: string,
    assistantText: string,
    parentSpanId: SpanId,
    correlationId: CorrelationId,
  ): Promise<void> {
    const memory = this.#options.memory;
    const policy = this.#options.agent.memoryPolicy;
    if (!memory || !policy.enabled || policy.readOnly || !policy.scopes.includes("session")) {
      return;
    }
    const ref: MemoryRef = { scope: "session", sessionId: this.#options.session.id };
    await memory.append(ref, "exchanges", { user: transcript, assistant: assistantText });
    await this.#emit(
      memoryWriteTrace(
        this.#traceCore(this.#ids.span(), correlationId, parentSpanId),
        ref,
        "exchanges",
        "append",
      ),
    );
  }

  async #emitSttFinal(
    turn: Turn,
    transcript: string,
    event: TranscriptEvent,
    parentSpanId: SpanId,
    correlationId: CorrelationId,
  ): Promise<void> {
    await this.#emit(
      sttFinalTrace(
        this.#traceCore(this.#ids.span(), correlationId, parentSpanId),
        turn.id,
        transcript,
        event,
      ),
    );
  }

  async #emit(event: TraceEvent): Promise<void> {
    await this.#options.runtime.emitTraceEvent(event);
  }

  #traceCore(spanId: SpanId, correlationId: CorrelationId, parentSpanId: SpanId) {
    return traceCore({
      id: this.#ids.traceEvent(),
      traceId: this.#options.session.traceId,
      sessionId: this.#options.session.id,
      timestamp: this.#clock.now(),
      monotonicOffsetMs: this.#monotonicMs(),
      spanId,
      parentSpanId,
      correlationId,
    });
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
    // Aborted before the provider was ready: cancel the handle once it resolves
    // so the orphaned connection/stream is not leaked.
    void startup.then((handle) => cancel(handle)).catch(() => undefined);
    return null;
  }

  #monotonicMs(): number {
    // One clock for everything: the runtime's session-relative monotonic offset.
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

const CLEAR_TIMEOUT_MS = 250;
// Backstop for provider stream startup (STT open); the provider's own connect
// timeout should normally fire first with a more specific error.
const STARTUP_TIMEOUT_MS = 15_000;
// How long to await a playout (mark) ack. Long enough to cover real playback; on
// timeout the transport reports unconfirmed (never a false "heard").
const PLAYOUT_CONFIRM_TIMEOUT_MS = 30_000;

/** A cancelable one-shot timer used to detect a stalled provider stream. */
function stallTimer(ms: number): { readonly promise: Promise<void>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

function abortPromise(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
