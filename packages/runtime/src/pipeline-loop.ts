import { isInputMediaEvent } from "@tvic/media";
import { executeTool } from "@tvic/tools";
import {
  audioOutputChunkTrace,
  audioOutputEndedTrace,
  audioOutputStartedTrace,
  llmStreamTrace,
  sttFinalTrace,
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
  IdGenerator,
  LLMProvider,
  LlmInlineToolCall,
  LlmMessage,
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
}

export interface PipelineVoiceLoopResult {
  readonly session: ActiveSession;
  readonly turnsHandled: number;
}

export class PipelineVoiceLoop {
  readonly #options: PipelineVoiceLoopOptions;
  readonly #ids: IdGenerator;
  readonly #clock: Clock;
  readonly #startedAtMs: number;
  readonly #policy: ConversationPolicy;
  #turnsHandled = 0;
  #turnChain: Promise<void> = Promise.resolve();

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

    const turnSpanId = this.#ids.span();
    const turnCorrelationId = this.#ids.correlation();
    await this.#emitSttFinal(turn, transcript, transcriptEvent, turnSpanId, turnCorrelationId);

    const messages = this.#policy.messagesForTranscript(transcript);
    const first = await this.#runLlm(turn, messages, turnSpanId);
    let finalText = first.text;
    const toolCallIds: ToolCallId[] = [];

    if (first.toolCalls.length > 0) {
      const toolMessages = await this.#executeToolCalls(turn, first.toolCalls, turnSpanId);
      toolCallIds.push(...toolMessages.toolCallIds);
      const continuation = await this.#runLlm(
        turn,
        this.#policy.messagesForToolContinuation(messages, first.text, toolMessages.messages),
        turnSpanId,
      );
      finalText = continuation.text;
    }

    await this.#speak(turn, finalText, turnSpanId);
    await this.#options.runtime.endTurn(this.#options.session.id, turn.id, {
      reason: "completed",
      output: { text: finalText, mediaEventIds: [] },
      toolCallIds,
    });

    this.#policy.recordTurn(transcript, finalText);
  }

  async #runLlm(
    turn: Turn,
    messages: readonly LlmMessage[],
    parentSpanId: SpanId,
  ): Promise<{ readonly text: string; readonly toolCalls: readonly LlmInlineToolCall[] }> {
    const spanId = this.#ids.span();
    const correlationId = this.#ids.correlation();
    const startedAtMs = this.#monotonicMs();
    let text = "";
    const toolCalls: LlmInlineToolCall[] = [];

    const completion = await this.#options.llm.complete({
      sessionId: this.#options.session.id,
      turnId: turn.id,
      model: this.#options.llmModel,
      messages,
      tools: this.#options.agent.tools,
      stream: true,
      temperature: 0.2,
    });

    for await (const event of completion.events) {
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
  ): Promise<{
    readonly messages: readonly LlmMessage[];
    readonly toolCallIds: readonly ToolCallId[];
  }> {
    const messages: LlmMessage[] = [];
    const toolCallIds: ToolCallId[] = [];

    for (const call of calls) {
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
      });
      const durationMs = this.#durationSince(startedAtMs);

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

  async #speak(turn: Turn, text: string, parentSpanId: SpanId): Promise<void> {
    if (!text) {
      return;
    }

    const ttsSpanId = this.#ids.span();
    const audioSpanId = this.#ids.span();
    const correlationId = this.#ids.correlation();
    const startedAtMs = this.#monotonicMs();
    let totalFrames = 0;
    let durationMs = 0;

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

    const stream = await this.#options.tts.synthesize({
      sessionId: this.#options.session.id,
      turnId: turn.id,
      text,
      ...(this.#options.ttsVoice ? { voice: this.#options.ttsVoice } : {}),
      ...(this.#options.ttsModel ? { model: this.#options.ttsModel } : {}),
      format: this.#options.agent.audioPolicy.output,
      stream: true,
    });

    for await (const event of stream.events) {
      await this.#options.callHandle.send(event);
      if (event.type === "media.audio.chunk") {
        totalFrames += event.audio.frameCount;
        durationMs += event.audio.durationMs;
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
        durationMs,
      ),
    );
  }

  async #emitSttFinal(
    turn: Turn,
    transcript: string,
    event: TranscriptEvent,
    parentSpanId: SpanId,
    correlationId: ReturnType<IdGenerator["correlation"]>,
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

  #traceCore(
    spanId: SpanId,
    correlationId: ReturnType<IdGenerator["correlation"]>,
    parentSpanId: SpanId,
  ) {
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
