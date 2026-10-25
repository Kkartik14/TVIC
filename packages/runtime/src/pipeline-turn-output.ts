import {
  isNormalizedError,
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
  TurnId,
  TtsStream,
  TtsSession,
  TtsUsageReporter,
  UsageModelOrigin,
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
import { PipelineLlmAccumulator } from "./pipeline-llm-accumulator.js";
import { playPipelineTtsStream } from "./pipeline-tts-playback.js";
import type { PendingAudioTapSendTracking } from "./pipeline-tts-playback.js";
import type { AudioTapDispatcher } from "./audio-tap.js";
import type { PipelineVoiceLoopOptions } from "./pipeline-loop.js";
import type { ActiveTurnControl, MutableTurnLatency } from "./turn-state.js";
import type { VoiceEvent } from "./voice-event.js";
import type { SessionUsageAccumulator, TtsAudioUsageOperation } from "./session-usage.js";

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
  readonly audioTapTimestampMs: () => number;
  readonly trackAudioTapOperation: () => () => void;
  readonly trackPendingAudioTapSend: (
    turnId: TurnId,
    onTapClose: () => void,
  ) => PendingAudioTapSendTracking;
  readonly abortActive: (reason: string) => void;
  readonly cancellationTimeout: (stage: string) => void;
  readonly audioTap: AudioTapDispatcher;
  readonly usage: SessionUsageAccumulator;
}

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
    const toolList = this.#resolveToolList();
    const usageOperation = this.#context.usage.beginLlmRequest({
      provider: this.#context.providers.llm.name,
      model: options.llmModel,
      modelSource: options.llmModelSource ?? "request",
    });
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
    ).catch((error: unknown) => {
      if (!control.abort.signal.aborted) usageOperation.finish();
      throw error;
    });
    if (!completion) {
      if (!control.abort.signal.aborted) usageOperation.finish();
      return { text: "", toolCalls: [] };
    }

    let iterator: AsyncIterator<LlmStreamEvent>;
    try {
      iterator = completion.events[Symbol.asyncIterator]();
    } catch (error) {
      let cancellationSettled = false;
      try {
        await cancelWithTimeout(
          () => completion.cancel(),
          pipelineConstants.CANCELLATION_TIMEOUT_MS,
          () => this.#context.cancellationTimeout("llm.cancel"),
        );
        cancellationSettled = true;
      } catch {}
      if (cancellationSettled && !control.abort.signal.aborted) usageOperation.finish();
      throw error;
    }
    const aborted = abortPromise(control.abort.signal);
    let terminalSeen = false;
    let completionStopped = false;
    let stalled = false;
    const releaseCompletion = (): void => {
      if (completionStopped) return;
      completionStopped = true;
      void returnAsyncIteratorWithTimeout(iterator, pipelineConstants.CANCELLATION_TIMEOUT_MS, () =>
        this.#context.cancellationTimeout("llm.iterator.return"),
      ).catch(() => undefined);
    };
    const recordTerminalUsage = (event: LlmStreamEvent): boolean => {
      if (event.type === "llm.completed") {
        terminalSeen = true;
        usageOperation.finish({
          ...(event.providerModel ? { providerModel: event.providerModel } : {}),
          ...(event.usageReport ? { usageReport: event.usageReport } : {}),
          ...(event.usage ? { usage: event.usage } : {}),
        });
        return true;
      }
      if (event.type === "llm.failed") {
        terminalSeen = true;
        usageOperation.finish({
          ...(event.providerModel ? { providerModel: event.providerModel } : {}),
          ...(event.usageReport ? { usageReport: event.usageReport } : {}),
        });
        return true;
      }
      return false;
    };
    const stopCompletion = async (onCancelled?: () => void): Promise<void> => {
      if (completionStopped) return;
      completionStopped = true;
      await cancelWithTimeout(
        () => completion.cancel(),
        pipelineConstants.CANCELLATION_TIMEOUT_MS,
        () => this.#context.cancellationTimeout("llm.cancel"),
      ).catch(() => undefined);
      await Promise.resolve();
      onCancelled?.();
      await returnAsyncIteratorWithTimeout(
        iterator,
        pipelineConstants.CANCELLATION_TIMEOUT_MS,
        () => this.#context.cancellationTimeout("llm.iterator.return"),
      );
    };
    const accumulator = new PipelineLlmAccumulator({
      cancel: () =>
        cancelWithTimeout(
          () => completion.cancel(),
          pipelineConstants.CANCELLATION_TIMEOUT_MS,
          () => this.#context.cancellationTimeout("llm.cancel"),
        ).catch(() => undefined),
      ...(onText ? { onText } : {}),
    });
    try {
      while (true) {
        const stall = stallTimer(this.#stallTimeoutMs());
        const next = iterator.next();
        next.catch(() => undefined);
        let nextResult: IteratorResult<LlmStreamEvent> | undefined;
        const step = await Promise.race([
          next.then((result) => {
            nextResult = result;
            return { kind: "event" as const, result };
          }),
          aborted.then(() => ({ kind: "abort" as const })),
          stall.promise.then(() => ({ kind: "timeout" as const })),
        ]);
        stall.cancel();

        if (step.kind === "timeout") {
          await stopCompletion(() => {
            const event = nextResult?.done ? undefined : nextResult?.value;
            if (event && event.sessionId === options.session.id && event.turnId === turn.id) {
              recordTerminalUsage(event);
            }
          });
          if (options.agent.timeoutPolicy.onTimeout === "interrupt") {
            this.#context.abortActive("timeout");
            break;
          }
          stalled = true;
          throw TvicThrowableError.from(
            timeoutError("llm.stalled", `LLM produced no event for ${this.#stallTimeoutMs()}ms`),
          );
        }
        if (step.kind === "abort") {
          await stopCompletion(() => {
            const event = nextResult?.done ? undefined : nextResult?.value;
            if (event && event.sessionId === options.session.id && event.turnId === turn.id) {
              recordTerminalUsage(event);
            }
          });
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
        if (control.abort.signal.aborted) {
          if (event.sessionId === options.session.id && event.turnId === turn.id) {
            recordTerminalUsage(event);
          }
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
        await accumulator.recordEvent();
        if (event.type === "llm.token") {
          if (control.abort.signal.aborted) break;
          latency.firstTokenMs ??= this.#durationSince(control.startedAtMs);
          await accumulator.appendText(event.text);
        } else if (event.type === "llm.tool_call") {
          await accumulator.addToolCall(event.call);
        } else if (event.type === "llm.completed") {
          recordTerminalUsage(event);
          await accumulator.complete(event.text, event.toolCalls);
          releaseCompletion();
          break;
        } else if (event.type === "llm.failed") {
          recordTerminalUsage(event);
          await stopCompletion();
          throw TvicThrowableError.from(event.error);
        }
      }
    } catch (error) {
      await stopCompletion().catch(() => undefined);
      if (!control.abort.signal.aborted && !terminalSeen && !stalled) usageOperation.finish();
      throw error;
    }
    return { text: accumulator.text.trim(), toolCalls: accumulator.toolCalls };
  }

  executeToolCalls(
    turn: Turn,
    calls: readonly LlmInlineToolCall[],
    control: ActiveTurnControl,
    latency: MutableTurnLatency,
  ): Promise<{
    readonly messages: readonly LlmMessage[];
    readonly toolCallIds: readonly ToolCallId[];
    readonly assistantToolCalls: readonly LlmInlineToolCall[];
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
              generationId: options.attachment.lease.generationId,
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
    const model = options.ttsModel ?? provider.configuredModel;
    return new IncrementalTtsInput({
      openSession: async () => {
        const usageReporter = this.#ttsUsageReporter(provider);
        const session = await provider.openSession({
          sessionId: options.session.id,
          turnId: turn.id,
          ...(options.ttsVoice ? { voice: options.ttsVoice } : {}),
          ...(model ? { model } : {}),
          ...(options.ttsTextControls ? { textControls: options.ttsTextControls } : {}),
          ...(options.ttsProviderCapabilitySnapshots !== undefined
            ? { providerCapabilitySnapshots: options.ttsProviderCapabilitySnapshots }
            : {}),
          format: options.agent.audioPolicy.output,
          timestamps: provider.capabilities.timestamps !== false,
          usageReporter,
          signal: control.abort.signal,
        });
        const usage: TtsSession = {
          events: session.events,
          cancel: () => session.cancel(),
          sendText: (text) => {
            this.#recordTtsTextInvocation(provider, text);
            return session.sendText(text);
          },
          flush: () => session.flush(),
          finish: () => session.finish(),
        };
        return usage;
      },
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
    const model = options.ttsModel ?? provider.configuredModel;
    if (!text) {
      control.outputDelivered = true;
      return;
    }

    const usageIdentity = this.#ttsUsageIdentity(provider);
    const audioUsage = this.#context.usage.beginTtsAudio(
      provider.name,
      usageIdentity.model,
      usageIdentity.modelSource,
    );
    let stream: TtsStream | null;
    try {
      stream = await raceStartup(
        Promise.resolve().then(() => {
          this.#recordTtsTextInvocation(provider, text);
          return provider.synthesize({
            sessionId: options.session.id,
            turnId: turn.id,
            text,
            ...(options.ttsVoice ? { voice: options.ttsVoice } : {}),
            ...(model ? { model } : {}),
            ...(options.ttsTextControls ? { textControls: options.ttsTextControls } : {}),
            ...(options.ttsProviderCapabilitySnapshots !== undefined
              ? { providerCapabilitySnapshots: options.ttsProviderCapabilitySnapshots }
              : {}),
            format: options.agent.audioPolicy.output,
            stream: true,
            usageReporter: this.#ttsUsageReporter(provider),
            signal: control.abort.signal,
          });
        }),
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
    } catch (error) {
      if (
        control.abort.signal.aborted ||
        (error instanceof TvicThrowableError && error.category === "timeout") ||
        (isNormalizedError(error) && error.category === "timeout")
      ) {
        audioUsage.interrupt();
      } else {
        audioUsage.finish();
      }
      throw error;
    }
    if (!stream) {
      audioUsage.interrupt();
      return;
    }

    await this.playTtsStream(stream, control, latency, audioUsage);
  }

  playTtsStream(
    stream: TtsStream,
    control: ActiveTurnControl,
    latency: MutableTurnLatency,
    existingAudioUsage?: TtsAudioUsageOperation,
  ): Promise<void> {
    const { options } = this.#context;
    const provider = this.#context.providers.tts;
    const outputReference = new WeakRef(this);
    const turnId = control.turnId;
    const usageIdentity = provider ? this.#ttsUsageIdentity(provider) : undefined;
    const audioUsage =
      existingAudioUsage ??
      this.#context.usage.beginTtsAudio(
        provider?.name ?? "unknown",
        usageIdentity?.model,
        usageIdentity?.modelSource,
      );
    return playPipelineTtsStream(stream, control, latency, {
      callHandle: options.callHandle,
      sessionId: options.session.id,
      turnId: control.turnId,
      stallTimeoutMs: this.#stallTimeoutMs(),
      onTimeout: options.agent.timeoutPolicy.onTimeout,
      monotonicMs: this.#context.monotonicMs,
      abortActive: this.#context.abortActive,
      onAudioReceived: (event) =>
        audioUsage.record({
          byteLength: event.audio.bytes.byteLength,
          format: event.audio.format,
        }),
      onInterrupted: () => audioUsage.interrupt(),
      emitAudio: (bytes, sequence) =>
        this.#context.emitVoiceEvent({
          kind: "audio_output",
          bytes,
          turnId: control.turnId,
          sequence,
        }),
      ...(options.audioTap
        ? {
            trackAudioTapOperation: this.#context.trackAudioTapOperation,
            trackPendingAudioTapSend: this.#context.trackPendingAudioTapSend,
            onAudioSent: (event: import("@tvic/core").OutputAudioChunk, bytesCaptured: boolean) => {
              const output = outputReference.deref();
              if (!output) return;
              output.#context.audioTap.audio({
                direction: "agent",
                turnId,
                bytes: bytesCaptured ? event.audio.bytes : null,
                format: event.audio.format,
                timestampMs: output.#context.audioTapTimestampMs(),
              });
            },
            onAudioTapDropped: () => this.#context.audioTap.recordDroppedFrames(1),
            onPlayout: ({
              markId,
              confirmed,
            }: {
              readonly markId: string;
              readonly confirmed: boolean;
            }) => {
              this.#context.audioTap.playout({
                turnId: control.turnId,
                markId,
                confirmed,
                timestampMs: this.#context.audioTapTimestampMs(),
              });
            },
          }
        : {}),
      onWarning: (error) =>
        this.#context.emitVoiceEvent({ kind: "error", error, recoverable: true }),
      onCancelTimeout: () => this.#context.cancellationTimeout("tts.cancel"),
      onIteratorTimeout: () => this.#context.cancellationTimeout("tts.iterator.return"),
    }).finally(() => audioUsage.finish());
  }

  #ttsUsageReporter(provider: TextToSpeechProvider): TtsUsageReporter {
    const reportsTextCharacters = provider.usageAccounting?.reportsTextCharacters === true;
    const { model, modelSource } = this.#ttsUsageIdentity(provider);
    return {
      report: (observation) =>
        this.#context.usage.reportProviderUsage(
          "tts",
          provider.name,
          observation,
          model,
          observation.modelSource === "provider_reported" ? "provider_reported" : modelSource,
        ),
      beginOperation: (input) =>
        this.#context.usage.beginProviderUsage(
          "tts",
          provider.name,
          {
            ...input,
            modelSource:
              input.modelSource === "provider_reported" ? "provider_reported" : modelSource,
          },
          model,
        ),
      reportTextCharacters: (codePoints) => {
        if (reportsTextCharacters) {
          this.#context.usage.reportTtsTextCharacters(
            provider.name,
            model,
            codePoints,
            modelSource,
          );
        }
      },
    };
  }

  #recordTtsTextInvocation(provider: TextToSpeechProvider, text: string): void {
    if (provider.usageAccounting?.reportsTextCharacters) return;
    this.#context.usage.recordTtsTextCharacters(
      provider.name,
      this.#context.options.ttsModel ?? provider.configuredModel,
      text,
      this.#ttsModelSource(provider),
    );
  }

  #ttsModelSource(provider: TextToSpeechProvider): UsageModelOrigin {
    const { options } = this.#context;
    if (options.ttsModelSource !== undefined) return options.ttsModelSource;
    if (options.ttsModel !== undefined) return "request";
    if (provider.configuredModelSource !== undefined) return provider.configuredModelSource;
    return provider.configuredModel !== undefined ? "configured" : "not_reported";
  }

  #ttsUsageIdentity(provider: TextToSpeechProvider): {
    readonly model: string | undefined;
    readonly modelSource: UsageModelOrigin;
  } {
    const usageAccounting = provider.usageAccounting;
    if (
      usageAccounting?.reportsTextCharacters === true &&
      usageAccounting.usesRequestModelForUsage !== true
    ) {
      return { model: undefined, modelSource: "not_reported" };
    }
    const model = this.#context.options.ttsModel ?? provider.configuredModel;
    return {
      model,
      modelSource: model === undefined ? "not_reported" : this.#ttsModelSource(provider),
    };
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
