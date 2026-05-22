import { isInputMediaEvent } from "@tvic/media";
import { executeTool } from "@tvic/tools";
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
  runtimeTimeoutTrace,
  sttFinalTrace,
  toolCancelledTrace,
  toolCompletedTrace,
  toolFailedTrace,
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
  monotonicOffsetMs,
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
  Runtime,
  SpanId,
  SpeechToTextProvider,
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
}

export interface PipelineVoiceLoopResult {
  readonly session: ActiveSession;
  readonly turnsHandled: number;
  readonly interruptions: number;
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
  outputFramesSent: number;
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
  readonly #startedAtMs: number;
  readonly #policy: ConversationPolicy;
  #turnsHandled = 0;
  #interruptions = 0;
  #turnChain: Promise<void> = Promise.resolve();
  #active: ActiveTurnControl | null = null;

  constructor(options: PipelineVoiceLoopOptions) {
    this.#options = options;
    this.#ids = options.idGenerator ?? createDefaultIdGenerator();
    this.#clock = options.clock ?? createSystemClock();
    this.#startedAtMs = this.#clock.monotonicMs();
    this.#policy = options.conversationPolicy ?? new ConversationPolicy({ agent: options.agent });
  }

  async run(): Promise<PipelineVoiceLoopResult> {
    const stt = await this.#options.stt.open({
      sessionId: this.#options.session.id,
      format: this.#options.agent.audioPolicy.input,
      ...(this.#options.sttLanguage ? { language: this.#options.sttLanguage } : {}),
      interimResults: true,
      vocabulary: this.#options.agent.tools.map((tool) => String(tool.name)),
    });

    const transcriptTask = this.#consumeTranscripts(stt.events);

    try {
      for await (const event of this.#options.callHandle.events) {
        if (!isInputMediaEvent(event)) {
          continue;
        }

        await this.#options.runtime.injectMediaEvent(event);

        if (event.type === "media.audio.chunk") {
          await stt.sendAudio(event);
        }

        if (event.type === "barge_in.detected") {
          await this.#interrupt("barge_in", event.confidence);
        }

        if (event.type === "media.stream.ended" || event.type === "media.error") {
          await stt.close();
          break;
        }
      }

      await this.#turnChain;
      await transcriptTask;
      return {
        session: this.#options.session,
        turnsHandled: this.#turnsHandled,
        interruptions: this.#interruptions,
      };
    } catch (error) {
      await stt.close();
      throw error;
    }
  }

  async #consumeTranscripts(events: AsyncIterable<TranscriptEvent>): Promise<void> {
    for await (const event of events) {
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
      outputFramesSent: 0,
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
    } finally {
      this.#active = null;
    }

    latency.totalMs = this.#durationSince(eouAtMs);

    if (control.interruptedAtMs !== null) {
      await this.#emit(
        interruptHandledTrace(
          this.#traceCore(this.#ids.span(), correlationId, parentSpanId),
          turn.id,
          this.#durationSince(control.interruptedAtMs),
          control.outputFramesSent > 0,
        ),
      );
      await this.#options.runtime.endTurn(this.#options.session.id, turn.id, {
        reason: "cancelled",
        cancelReason: "barge_in",
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
    // confirmation are enforced upstream in the media plane (VAD), so a
    // barge_in.detected event reaching the runtime is already qualified speech;
    // here we only honour whether the agent accepts interruptions at all.
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
  async #clearOutput(cause: string, control: ActiveTurnControl): Promise<void> {
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
      }),
      control.abort.signal,
      (handle) => handle.cancel(),
    );
    if (!completion) {
      return { text: "", toolCalls: [] };
    }

    // Race each event against abort so barge-in cancels generation immediately,
    // even when the provider stream is blocked waiting on the network.
    const iterator = completion.events[Symbol.asyncIterator]();
    const aborted = abortPromise(control.abort.signal);

    while (true) {
      const step = await Promise.race([
        iterator.next().then((result) => ({ kind: "event" as const, result })),
        aborted.then(() => ({ kind: "abort" as const })),
      ]);

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
      }
      if (event.type === "llm.completed" && !text) {
        text = event.text;
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
      });
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
      return;
    }

    const ttsSpanId = this.#ids.span();
    const audioSpanId = this.#ids.span();
    const correlationId = this.#ids.correlation();
    const startedAtMs = this.#monotonicMs();
    let totalFrames = 0;
    let playedMs = 0;

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

    // Race each chunk against the abort signal so barge-in stops playout
    // immediately, instead of waiting for the next TTS chunk to arrive.
    const iterator = stream.events[Symbol.asyncIterator]();
    const aborted = abortPromise(control.abort.signal);

    while (true) {
      const step = await Promise.race([
        iterator.next().then((result) => ({ kind: "chunk" as const, result })),
        aborted.then(() => ({ kind: "abort" as const })),
      ]);

      if (step.kind === "abort") {
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
        return;
      }

      if (step.result.done) {
        break;
      }
      const event = step.result.value;

      await this.#options.callHandle.send(event);
      if (event.type === "media.audio.chunk") {
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
    await this.#emit(
      audioOutputEndedTrace(
        this.#traceCore(audioSpanId, correlationId, parentSpanId),
        turn.id,
        playedMs,
      ),
    );
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
    return monotonicOffsetMs(this.#clock, this.#startedAtMs);
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
