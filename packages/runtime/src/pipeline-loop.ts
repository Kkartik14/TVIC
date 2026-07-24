import { isInputMediaEvent } from "@tvic/media";
import { executeTool, InMemoryToolIdempotencyStore } from "@tvic/tools";
import {
  createDefaultIdGenerator,
  internalError,
  isIncrementalTextToSpeechProvider,
  isTranscriptSegmentEvent,
  isNormalizedError,
  timeoutError,
} from "@tvic/core";
import type {
  ActiveSession,
  Agent,
  AgentPipelineProviders,
  CallHandle,
  IdGenerator,
  LlmInlineToolCall,
  LlmMessage,
  Memory,
  MemoryRef,
  NormalizedError,
  Runtime,
  SttStream,
  ToolCallId,
  TranscriptEvent,
  TtsStream,
  Turn,
} from "@tvic/core";

import { ConversationPolicy } from "./conversation-policy.js";
import { IncrementalTtsInput } from "./incremental-tts-input.js";

export interface PipelineVoiceLoopOptions {
  readonly runtime: Runtime;
  readonly session: ActiveSession;
  readonly agent: Agent;
  readonly callHandle: CallHandle;
  readonly llmModel: string;
  readonly sttLanguage?: string;
  readonly ttsVoice?: string;
  readonly ttsModel?: string;
  readonly idGenerator?: IdGenerator;
  readonly conversationPolicy?: ConversationPolicy;
  readonly memory?: Memory;
  /** Max ms a provider stream may stall (no events) before the turn fails. */
  readonly streamStallTimeoutMs?: number;
  /** Inactivity debounce after the latest immutable final segment. */
  readonly turnEndpointTimeoutMs?: number;
  /** Absolute cap from the first immutable final segment in one utterance. */
  readonly turnMaxDurationMs?: number;
}

export interface PipelineVoiceLoopResult {
  readonly session: ActiveSession;
  readonly turnsHandled: number;
  readonly interruptions: number;
  readonly turnsFailed: number;
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
  readonly startedAtMs: number;
  interruptedAtMs: number | null;
  cancelReason: string;
  outputFramesSent: number;
  speaking: boolean;
  outputDelivered: boolean;
  alignedTokens: string[];
  alignedDurationMs: number;
  lastFlushId: number | null;
}

/**
 * Runs a pipeline voice session: media -> STT -> LLM/tools -> TTS -> media.
 * This module owns only live execution and failure handling; telemetry belongs
 * outside the runtime's critical path.
 */
export class PipelineVoiceLoop {
  readonly #options: PipelineVoiceLoopOptions;
  readonly #providers: AgentPipelineProviders;
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
  #endpointTimer: ReturnType<typeof setTimeout> | null = null;
  #turnDurationTimer: ReturnType<typeof setTimeout> | null = null;
  #bargeInTimer: ReturnType<typeof setTimeout> | null = null;
  #speechCandidate:
    | {
        readonly turnId: Turn["id"];
        readonly startedAtMs: number;
        readonly audioOffsetMs?: number;
      }
    | undefined;

  constructor(options: PipelineVoiceLoopOptions) {
    this.#options = options;
    this.#providers = options.agent.providers;
    this.#ids = options.idGenerator ?? createDefaultIdGenerator();
    this.#policy = options.conversationPolicy ?? new ConversationPolicy({ agent: options.agent });
    this.#stallTimeoutMs = options.streamStallTimeoutMs ?? options.agent.timeoutPolicy.timeoutMs;
    this.#turnEndpointTimeoutMs = options.turnEndpointTimeoutMs ?? DEFAULT_TURN_ENDPOINT_TIMEOUT_MS;
    this.#turnMaxDurationMs = options.turnMaxDurationMs ?? DEFAULT_TURN_MAX_DURATION_MS;
    this.#onTimeout = options.agent.timeoutPolicy.onTimeout;
  }

  async run(): Promise<PipelineVoiceLoopResult> {
    const startupAbort = new AbortController();
    let stt: SttStream;
    try {
      stt = await withTimeout(
        this.#providers.stt.open({
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
      startupAbort.abort();
      throw internalError(
        "stt.open_failed",
        error instanceof Error ? error.message : String(error),
      );
    }

    const supervisor = new AbortController();
    let sttError: unknown = null;
    let sttEnded = false;
    const transcriptTask = this.#consumeTranscripts(stt.events);
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
      endReason = "media_error";
      streamError = internalError(
        "media.input_failed",
        error instanceof Error ? error.message : String(error),
      );
      mediaEnded = true;
    }

    this.#shutdownReason = sttError ? "stt_error" : sttEnded ? "stt_ended" : endReason;

    if (mediaEnded && !sttEnded && this.#policy.hasBufferedTranscript) {
      await stt.commit().catch(() => undefined);
      await waitUntil(() => !this.#policy.hasBufferedTranscript, TRANSCRIPT_FINALIZE_GRACE_MS);
    }

    this.#abortActive(this.#shutdownReason);
    this.#cancelBargeInCandidate();
    await stt.close().catch(() => undefined);
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
        next.catch(() => undefined);
        const step = await Promise.race([
          next.then((result) => ({ kind: "event" as const, result })),
          aborted.then(() => ({ kind: "aborted" as const })),
        ]);
        if (step.kind === "aborted") {
          break;
        }
        if (step.result.done) {
          mediaEnded = true;
          break;
        }
        const event = step.result.value;
        if (!isInputMediaEvent(event)) {
          continue;
        }

        if (event.type === "media.audio.chunk") {
          await stt.sendAudio(event);
        }
        if (event.type === "dtmf.received" && this.#active?.speaking) {
          await this.#interrupt("dtmf");
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

  #abortActive(reason: string): void {
    const control = this.#active;
    if (control && control.interruptedAtMs === null && !control.outputDelivered) {
      control.interruptedAtMs = this.#monotonicMs();
      control.cancelReason = reason;
      control.abort.abort();
    }
  }

  async #consumeTranscripts(events: AsyncIterable<TranscriptEvent>): Promise<void> {
    try {
      for await (const event of events) {
        await this.#considerSpeechForBargeIn(event);
        const transcript = this.#policy.acceptTranscript(event);
        if (event.type === "stt.final" && this.#policy.hasBufferedTranscript) {
          this.#armEndpointTimers();
        } else if (event.type === "stt.endpoint") {
          this.#cancelEndpointTimers();
        }
        if (transcript) {
          this.#queueTranscript(transcript);
        }
      }
    } finally {
      this.#cancelEndpointTimers();
    }

    const trailingTranscript = this.#policy.flushBufferedTranscript();
    if (trailingTranscript) {
      this.#queueTranscript(trailingTranscript);
    }
  }

  #queueTranscript(transcript: string): void {
    this.#turnChain = this.#turnChain.then(() => this.#handleTranscript(transcript));
  }

  #armEndpointTimers(): void {
    this.#cancelEndpointTimer();
    this.#endpointTimer = setTimeout(() => {
      this.#flushTimedEndpoint();
    }, this.#turnEndpointTimeoutMs);

    this.#turnDurationTimer ??= setTimeout(() => {
      this.#flushTimedEndpoint();
    }, this.#turnMaxDurationMs);
  }

  #flushTimedEndpoint(): void {
    this.#cancelEndpointTimers();
    const transcript = this.#policy.flushBufferedTranscript();
    if (transcript) {
      this.#queueTranscript(transcript);
    }
  }

  #cancelEndpointTimer(): void {
    if (this.#endpointTimer) {
      clearTimeout(this.#endpointTimer);
      this.#endpointTimer = null;
    }
  }

  #cancelEndpointTimers(): void {
    this.#cancelEndpointTimer();
    if (this.#turnDurationTimer) {
      clearTimeout(this.#turnDurationTimer);
      this.#turnDurationTimer = null;
    }
  }

  async #considerSpeechForBargeIn(event: TranscriptEvent): Promise<void> {
    if (this.#options.agent.interruptionPolicy.mode === "ignore") {
      this.#cancelBargeInCandidate();
      return;
    }
    const active = this.#active;
    if (!active?.speaking) {
      this.#cancelBargeInCandidate();
      return;
    }

    if (event.type === "stt.speech.started") {
      this.#startBargeInCandidate(active, event.audioOffsetMs);
      return;
    }

    if (event.type === "stt.endpoint") {
      const candidate = this.#speechCandidate;
      const audioSpeechMs =
        typeof candidate?.audioOffsetMs === "number" && typeof event.audioOffsetMs === "number"
          ? event.audioOffsetMs - candidate.audioOffsetMs
          : 0;
      const wallSpeechMs = candidate ? this.#monotonicMs() - candidate.startedAtMs : 0;
      if (
        candidate &&
        Math.max(audioSpeechMs, wallSpeechMs) >= this.#options.agent.interruptionPolicy.minSpeechMs
      ) {
        await this.#interrupt("barge_in");
      } else {
        this.#cancelBargeInCandidate();
      }
      return;
    }

    if (!isTranscriptSegmentEvent(event) || event.text.trim().length === 0) {
      return;
    }

    this.#startBargeInCandidate(active, event.audioStartMs);
    const candidate = this.#speechCandidate;
    const audioSpeechMs =
      typeof candidate?.audioOffsetMs === "number" && typeof event.audioEndMs === "number"
        ? event.audioEndMs - candidate.audioOffsetMs
        : 0;
    const wallSpeechMs = candidate ? this.#monotonicMs() - candidate.startedAtMs : 0;
    if (
      Math.max(audioSpeechMs, wallSpeechMs) >= this.#options.agent.interruptionPolicy.minSpeechMs
    ) {
      await this.#interrupt("barge_in");
    }
  }

  #startBargeInCandidate(active: ActiveTurnControl, audioOffsetMs?: number): void {
    if (this.#speechCandidate?.turnId === active.turnId) {
      return;
    }
    this.#cancelBargeInCandidate();
    this.#speechCandidate = {
      turnId: active.turnId,
      startedAtMs: this.#monotonicMs(),
      ...(typeof audioOffsetMs === "number" ? { audioOffsetMs } : {}),
    };

    const minSpeechMs = this.#options.agent.interruptionPolicy.minSpeechMs;
    if (minSpeechMs <= 0) {
      void this.#interrupt("barge_in");
      return;
    }
    this.#bargeInTimer = setTimeout(() => {
      this.#bargeInTimer = null;
      if (this.#active?.turnId === active.turnId && this.#active.speaking) {
        void this.#interrupt("barge_in");
      }
    }, minSpeechMs);
  }

  #cancelBargeInCandidate(): void {
    if (this.#bargeInTimer) {
      clearTimeout(this.#bargeInTimer);
      this.#bargeInTimer = null;
    }
    this.#speechCandidate = undefined;
  }

  async #handleTranscript(transcript: string): Promise<void> {
    const turn = await this.#options.runtime.startTurn({
      sessionId: this.#options.session.id,
      input: { transcript, mediaEventIds: [] },
    });
    this.#turnsHandled += 1;

    const startedAtMs = this.#monotonicMs();
    const control: ActiveTurnControl = {
      turnId: turn.id,
      abort: new AbortController(),
      startedAtMs,
      interruptedAtMs: null,
      cancelReason: "barge_in",
      outputFramesSent: 0,
      speaking: false,
      outputDelivered: false,
      alignedTokens: [],
      alignedDurationMs: 0,
      lastFlushId: null,
    };
    this.#active = control;
    if (this.#shutdownReason) {
      control.interruptedAtMs = this.#monotonicMs();
      control.cancelReason = this.#shutdownReason;
      control.abort.abort();
    }
    const latency: MutableTurnLatency = {};
    let finalText = "";
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
            this.#abortActive("tts_failed");
            throw error;
          })
      : null;
    incrementalPlayback?.catch(() => undefined);
    const onLlmText = incrementalInput
      ? (text: string): Promise<void> => incrementalInput.pushToken(text)
      : undefined;

    try {
      const messages = this.#policy.messagesForTranscript(transcript);
      const first = await this.#runLlm(turn, messages, control, latency, onLlmText);
      finalText = first.text;

      if (!control.abort.signal.aborted && first.toolCalls.length > 0) {
        await incrementalInput?.flushBoundary();
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

      if (!control.abort.signal.aborted) {
        if (incrementalInput) {
          await incrementalInput.finish();
          await incrementalPlayback;
        } else {
          await this.#speak(turn, finalText, control, latency);
        }
      } else if (incrementalInput) {
        await incrementalInput.cancel();
        await incrementalPlayback?.catch(() => undefined);
      }
      latency.totalMs = this.#durationSince(startedAtMs);

      if (!control.outputDelivered) {
        await this.#options.runtime.endTurn(this.#options.session.id, turn.id, {
          reason: "cancelled",
          cancelReason: control.interruptedAtMs !== null ? control.cancelReason : "not_heard",
          output: { text: finalText, mediaEventIds: [] },
          toolCallIds,
          latency,
        });
        if (control.interruptedAtMs !== null && control.cancelReason === "barge_in") {
          const alignedText =
            control.alignedDurationMs > 0 ? control.alignedTokens.join(" ").trim() : "";
          const interruptedText = alignedText || finalText;
          this.#policy.recordInterruptedTurn(transcript, interruptedText);
          await this.#updateMemory(transcript, interruptedText, true).catch(() => undefined);
        }
        return;
      }

      await this.#options.runtime.endTurn(this.#options.session.id, turn.id, {
        reason: "completed",
        output: { text: finalText, mediaEventIds: [] },
        toolCallIds,
        latency,
      });
      this.#policy.recordTurn(transcript, finalText);
      await this.#updateMemory(transcript, finalText).catch(() => undefined);
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
    } finally {
      await incrementalInput?.cancel().catch(() => undefined);
      await incrementalPlayback?.catch(() => undefined);
      this.#cancelBargeInCandidate();
      this.#active = null;
    }
  }

  async #interrupt(cause: "barge_in" | "dtmf" | "explicit" | "timeout"): Promise<void> {
    const control = this.#active;
    if (!control || control.interruptedAtMs !== null) {
      return;
    }
    if (this.#options.agent.interruptionPolicy.mode === "ignore") {
      return;
    }

    control.interruptedAtMs = this.#monotonicMs();
    control.cancelReason = cause;
    this.#interruptions += 1;
    this.#cancelBargeInCandidate();
    control.abort.abort();
    if (this.#options.agent.interruptionPolicy.trimOutputOnInterrupt) {
      await this.#trimOutput();
    }
  }

  async #trimOutput(): Promise<void> {
    await withTimeout(this.#options.callHandle.clear(), CLEAR_TIMEOUT_MS).catch(() => undefined);
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
    const completion = await this.#raceStartup(
      this.#providers.llm.complete({
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
    if (!isIncrementalTextToSpeechProvider(provider)) {
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
      this.#providers.tts.synthesize({
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
        appendAlignedTokens(control.alignedTokens, raw.tokens);
        control.alignedDurationMs = Math.max(control.alignedDurationMs, ...raw.endMs, 0);
        continue;
      }
      if (raw.type === "tts.flush.completed") {
        if (control.lastFlushId !== null && raw.flushId <= control.lastFlushId) {
          await stream.cancel();
          throw internalError(
            "tts.flush_out_of_order",
            `TTS flush ${raw.flushId} followed ${control.lastFlushId}`,
          );
        }
        control.lastFlushId = raw.flushId;
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
      confirm.call(this.#options.callHandle, markId, PLAYOUT_CONFIRM_TIMEOUT_MS),
      abortPromise(control.abort.signal).then(() => false),
    ]);
  }

  async #updateMemory(
    transcript: string,
    assistantText: string,
    interrupted = false,
  ): Promise<void> {
    const memory = this.#options.memory;
    const policy = this.#options.agent.memoryPolicy;
    if (!memory || !policy.enabled || policy.readOnly || !policy.scopes.includes("session")) {
      return;
    }
    const ref: MemoryRef = { scope: "session", sessionId: this.#options.session.id };
    await memory.append(ref, "exchanges", {
      user: transcript,
      assistant: assistantText,
      ...(interrupted ? { interrupted: true } : {}),
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

const CLEAR_TIMEOUT_MS = 250;
const STARTUP_TIMEOUT_MS = 15_000;
const PLAYOUT_CONFIRM_TIMEOUT_MS = 30_000;
const DEFAULT_TURN_ENDPOINT_TIMEOUT_MS = 3_000;
const DEFAULT_TURN_MAX_DURATION_MS = 30_000;
const TRANSCRIPT_FINALIZE_GRACE_MS = 250;

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

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function appendAlignedTokens(target: string[], incoming: readonly string[]): void {
  const maxOverlap = Math.min(target.length, incoming.length);
  let overlap = maxOverlap;
  while (
    overlap > 0 &&
    !incoming
      .slice(0, overlap)
      .every((token, index) => target[target.length - overlap + index] === token)
  ) {
    overlap -= 1;
  }
  target.push(...incoming.slice(overlap));
}
