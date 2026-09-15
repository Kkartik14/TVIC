import {
  isIncrementalTextToSpeechProvider,
  providerError,
  timeoutError,
  TvicThrowableError,
} from "@tvic/core";
import type {
  AgentProviders,
  IdGenerator,
  LlmInlineToolCall,
  LlmMessage,
  LlmStreamEvent,
  Memory,
  OrganizationId,
  QueuedToolCall,
  RunningToolCall,
  TextToSpeechProvider,
  ToolCallId,
  ToolDefinition,
  ToolIdempotencyStore,
  TerminalToolCall,
  Turn,
  TtsStream,
  UserId,
  WorkflowId,
} from "@tvic/core";
import { ConversationPolicy } from "./conversation-policy.js";
import { IncrementalTtsInput } from "./incremental-tts-input.js";
import {
  abortPromise,
  cancelWithTimeout,
  raceStartup,
  returnAsyncIteratorWithTimeout,
  stallTimer,
} from "./async-control.js";
import * as pipelineConstants from "./pipeline-constants.js";
import { executePipelineToolCalls, resolveAgentTools } from "./pipeline-tool-exec.js";
import { playPipelineTtsStream } from "./pipeline-tts-playback.js";
import type { PipelineVoiceLoopOptions } from "./pipeline-loop.js";
import type { ActiveTurnControl, MutableTurnLatency } from "./turn-state.js";
import type { VoiceEvent } from "./voice-event.js";

interface PipelineTurnOutputContext {
  readonly options: PipelineVoiceLoopOptions;
  readonly providers: AgentProviders;
  readonly ids: IdGenerator;
  readonly policy: ConversationPolicy;
  readonly idempotency: ToolIdempotencyStore;
  readonly memory: Memory | undefined;
  readonly memoryUserId: UserId | undefined;
  readonly organizationId: OrganizationId | undefined;
  readonly workflowId: WorkflowId | undefined;
  readonly emitVoiceEvent: (event: VoiceEvent) => void;
  readonly startToolCall: (queued: QueuedToolCall) => Promise<RunningToolCall>;
  readonly finishToolCall: (result: TerminalToolCall) => Promise<TerminalToolCall>;
  readonly recordToolCall: (result: TerminalToolCall) => Promise<TerminalToolCall>;
  readonly monotonicMs: () => number;
  readonly abortActive: (reason: string) => void;
  readonly cancellationTimeout: (stage: string) => void;
}

/** Owns model streaming, tool continuation, and TTS handoff for one turn. */
export class PipelineTurnOutput {
  readonly #context: PipelineTurnOutputContext;
  #memoryTool: ToolDefinition | undefined;

  constructor(context: PipelineTurnOutputContext) {
    this.#context = context;
  }

  async runLlm(
    turn: Turn,
    messages: readonly LlmMessage[],
    control: ActiveTurnControl,
    latency: MutableTurnLatency,
    onText?: (text: string) => Promise<void>,
  ): Promise<{ readonly text: string; readonly toolCalls: readonly LlmInlineToolCall[] }> {
    const { options } = this.#context;
    let text = "";
    const toolCalls: LlmInlineToolCall[] = [];
    const seenToolRefs = new Set<string>();
    const toolList = this.#resolveToolList();
    const completion = await raceStartup(
      Promise.resolve().then(() =>
        this.#context.providers.llm.complete({
          sessionId: options.session.id,
          turnId: turn.id,
          model: options.llmModel,
          messages,
          tools: toolList,
          stream: true,
          temperature: 0.2,
          ...(options.safetyIdentifier ? { safetyIdentifier: options.safetyIdentifier } : {}),
          signal: control.abort.signal,
        }),
      ),
      control.abort.signal,
      (handle) => handle.cancel(),
      {
        timeoutMs: pipelineConstants.STARTUP_TIMEOUT_MS,
        timeoutReason: timeoutError(
          "llm.open_timeout",
          `LLM startup timed out after ${pipelineConstants.STARTUP_TIMEOUT_MS}ms`,
        ),
        onCancelTimeout: () => this.#context.cancellationTimeout("llm.cancel"),
      },
    );
    if (!completion) {
      return { text: "", toolCalls: [] };
    }

    let iterator: AsyncIterator<LlmStreamEvent>;
    try {
      iterator = completion.events[Symbol.asyncIterator]();
    } catch (error) {
      // A malformed provider can throw before returning an iterator. The
      // completion still owns provider resources, so give it the same bounded
      // cancellation cleanup as every other startup/stream failure.
      await cancelWithTimeout(
        () => completion.cancel(),
        pipelineConstants.CANCELLATION_TIMEOUT_MS,
        () => this.#context.cancellationTimeout("llm.cancel"),
      ).catch(() => undefined);
      throw error;
    }
    const aborted = abortPromise(control.abort.signal);
    let terminalSeen = false;
    let completionStopped = false;
    const releaseCompletion = (): void => {
      if (completionStopped) return;
      completionStopped = true;
      // `llm.completed` is terminal even when a custom provider does not
      // close its iterable. Release a pending read without cancelling a
      // request that has already completed.
      void returnAsyncIteratorWithTimeout(iterator, pipelineConstants.CANCELLATION_TIMEOUT_MS, () =>
        this.#context.cancellationTimeout("llm.iterator.return"),
      ).catch(() => undefined);
    };
    const stopCompletion = async (): Promise<void> => {
      if (completionStopped) return;
      completionStopped = true;
      await cancelWithTimeout(
        () => completion.cancel(),
        pipelineConstants.CANCELLATION_TIMEOUT_MS,
        () => this.#context.cancellationTimeout("llm.cancel"),
      ).catch(() => undefined);
      await returnAsyncIteratorWithTimeout(
        iterator,
        pipelineConstants.CANCELLATION_TIMEOUT_MS,
        () => this.#context.cancellationTimeout("llm.iterator.return"),
      );
    };
    try {
      while (true) {
        const stall = stallTimer(this.#stallTimeoutMs());
        const next = iterator.next();
        next.catch(() => undefined);
        const step = await Promise.race([
          next.then((result) => ({ kind: "event" as const, result })),
          aborted.then(() => ({ kind: "abort" as const })),
          stall.promise.then(() => ({ kind: "timeout" as const })),
        ]);
        stall.cancel();

        if (step.kind === "timeout") {
          await stopCompletion();
          if (options.agent.timeoutPolicy.onTimeout === "interrupt") {
            this.#context.abortActive("timeout");
            break;
          }
          throw TvicThrowableError.from(
            timeoutError("llm.stalled", `LLM produced no event for ${this.#stallTimeoutMs()}ms`),
          );
        }
        if (step.kind === "abort") {
          await stopCompletion();
          break;
        }
        if (step.result.done) {
          if (control.abort.signal.aborted || terminalSeen) break;
          await stopCompletion();
          throw TvicThrowableError.from(
            providerError("llm.stream_ended", "LLM provider stream ended before a terminal event", {
              provider: this.#context.providers.llm.name,
              retriable: true,
            }),
          );
        }

        const event = step.result.value;
        // A provider event can resolve the read race in the same turn that
        // interruption wins. The abort is authoritative.
        if (control.abort.signal.aborted) {
          await stopCompletion();
          break;
        }
        if (event.sessionId !== options.session.id || event.turnId !== turn.id) {
          await stopCompletion();
          throw TvicThrowableError.from(
            providerError("provider.identity_mismatch", "LLM event identity mismatch", {
              provider: event.provider,
              retriable: false,
            }),
          );
        }
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
          terminalSeen = true;
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
          releaseCompletion();
          break;
        } else if (event.type === "llm.failed") {
          terminalSeen = true;
          await stopCompletion();
          throw TvicThrowableError.from(event.error);
        }
      }
    } catch (error) {
      // Stop an active provider iterator before propagating an observer or
      // incremental-TTS failure.
      await stopCompletion().catch(() => undefined);
      throw error;
    }
    return { text: text.trim(), toolCalls };
  }

  executeToolCalls(
    turn: Turn,
    calls: readonly LlmInlineToolCall[],
    control: ActiveTurnControl,
    latency: MutableTurnLatency,
  ): Promise<{
    readonly messages: readonly LlmMessage[];
    readonly toolCallIds: readonly ToolCallId[];
  }> {
    const { options } = this.#context;
    return executePipelineToolCalls(
      {
        ids: this.#context.ids,
        monotonicMs: this.#context.monotonicMs,
        sessionId: options.session.id,
        lease: options.attachment?.lease
          ? {
              holder: options.attachment.lease.holder,
              fence: options.attachment.lease.fence,
            }
          : undefined,
        userId: this.#context.memoryUserId,
        organizationId: this.#context.organizationId,
        workflowId: this.#context.workflowId,
        findTool: (call) => this.#context.policy.findTool(call),
        memoryTool: this.#memoryTool,
        idempotency: this.#context.idempotency,
        emitVoiceEvent: this.#context.emitVoiceEvent,
        startToolCall: this.#context.startToolCall,
        finishToolCall: this.#context.finishToolCall,
        recordToolCall: this.#context.recordToolCall,
      },
      turn,
      calls,
      control,
      latency,
    );
  }

  incrementalTtsInput(turn: Turn, control: ActiveTurnControl): IncrementalTtsInput | null {
    const provider = this.#context.providers.tts;
    if (!provider || !isIncrementalTextToSpeechProvider(provider)) {
      return null;
    }
    const { options } = this.#context;
    return new IncrementalTtsInput({
      openSession: () =>
        provider.openSession({
          sessionId: options.session.id,
          turnId: turn.id,
          ...(options.ttsVoice ? { voice: options.ttsVoice } : {}),
          ...(options.ttsModel ? { model: options.ttsModel } : {}),
          format: options.agent.audioPolicy.output,
          timestamps: true,
          signal: control.abort.signal,
        }),
    });
  }

  async speak(
    provider: TextToSpeechProvider,
    turn: Turn,
    text: string,
    control: ActiveTurnControl,
    latency: MutableTurnLatency,
  ): Promise<void> {
    const { options } = this.#context;
    if (!text) {
      control.outputDelivered = true;
      return;
    }

    const stream = await raceStartup(
      Promise.resolve().then(() =>
        provider.synthesize({
          sessionId: options.session.id,
          turnId: turn.id,
          text,
          ...(options.ttsVoice ? { voice: options.ttsVoice } : {}),
          ...(options.ttsModel ? { model: options.ttsModel } : {}),
          format: options.agent.audioPolicy.output,
          stream: true,
          signal: control.abort.signal,
        }),
      ),
      control.abort.signal,
      (handle) => handle.cancel(),
      {
        timeoutMs: pipelineConstants.STARTUP_TIMEOUT_MS,
        timeoutReason: timeoutError(
          "tts.open_timeout",
          `TTS startup timed out after ${pipelineConstants.STARTUP_TIMEOUT_MS}ms`,
        ),
        onCancelTimeout: () => this.#context.cancellationTimeout("tts.cancel"),
      },
    );
    if (!stream) {
      return;
    }

    await this.playTtsStream(stream, control, latency);
  }

  playTtsStream(
    stream: TtsStream,
    control: ActiveTurnControl,
    latency: MutableTurnLatency,
  ): Promise<void> {
    const { options } = this.#context;
    return playPipelineTtsStream(stream, control, latency, {
      callHandle: options.callHandle,
      sessionId: options.session.id,
      turnId: control.turnId,
      stallTimeoutMs: this.#stallTimeoutMs(),
      onTimeout: options.agent.timeoutPolicy.onTimeout,
      monotonicMs: this.#context.monotonicMs,
      abortActive: this.#context.abortActive,
      emitAudio: (bytes, sequence) =>
        this.#context.emitVoiceEvent({
          kind: "audio_output",
          bytes,
          turnId: control.turnId,
          sequence,
        }),
      onWarning: (error) =>
        this.#context.emitVoiceEvent({ kind: "error", error, recoverable: true }),
      onCancelTimeout: () => this.#context.cancellationTimeout("tts.cancel"),
      onIteratorTimeout: () => this.#context.cancellationTimeout("tts.iterator.return"),
    });
  }

  #resolveToolList(): readonly ToolDefinition[] {
    const { options } = this.#context;
    const resolved = resolveAgentTools({
      tools: options.agent.tools,
      memoryPolicy: options.agent.memoryPolicy,
      memory: this.#context.memory,
      runtime: options.runtime,
      sessionId: options.session.id,
      attachmentSignal: options.attachment?.signal,
      userId: this.#context.memoryUserId,
      organizationId: this.#context.organizationId,
      workflowId: this.#context.workflowId,
    });
    this.#memoryTool = resolved.memoryTool;
    return resolved.tools;
  }

  #stallTimeoutMs(): number {
    return (
      this.#context.options.streamStallTimeoutMs ??
      this.#context.options.agent.timeoutPolicy.timeoutMs
    );
  }

  #durationSince(startedAtMs: number): number {
    return Math.max(0, this.#context.monotonicMs() - startedAtMs);
  }
}
