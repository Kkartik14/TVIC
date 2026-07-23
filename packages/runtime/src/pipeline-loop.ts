import { isInputMediaEvent } from "@tvic/media";
import { executeTool, InMemoryToolIdempotencyStore } from "@tvic/tools";
import {
  createDefaultIdGenerator,
  internalError,
  isNormalizedError,
  timeoutError,
} from "@tvic/core";
import type {
  ActiveSession,
  Agent,
  CallHandle,
  IdGenerator,
  LLMProvider,
  LlmInlineToolCall,
  LlmMessage,
  Memory,
  MemoryRef,
  NormalizedError,
  Runtime,
  SpeechToTextProvider,
  SttStream,
  TextToSpeechProvider,
  ToolCallId,
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
}

/**
 * Runs a pipeline voice session: media -> STT -> LLM/tools -> TTS -> media.
 * This module owns only live execution and failure handling; telemetry belongs
 * outside the runtime's critical path.
 */
export class PipelineVoiceLoop {
  readonly #options: PipelineVoiceLoopOptions;
  readonly #ids: IdGenerator;
  readonly #policy: ConversationPolicy;
  readonly #idempotency = new InMemoryToolIdempotencyStore();
  readonly #stallTimeoutMs: number;
  readonly #onTimeout: "fail" | "interrupt";
  #turnsHandled = 0;
  #turnsFailed = 0;
  #firstTurnError: NormalizedError | null = null;
  #interruptions = 0;
  #turnChain: Promise<void> = Promise.resolve();
  #active: ActiveTurnControl | null = null;

  constructor(options: PipelineVoiceLoopOptions) {
    this.#options = options;
    this.#ids = options.idGenerator ?? createDefaultIdGenerator();
    this.#policy = options.conversationPolicy ?? new ConversationPolicy({ agent: options.agent });
    this.#stallTimeoutMs = options.streamStallTimeoutMs ?? options.agent.timeoutPolicy.timeoutMs;
    this.#onTimeout = options.agent.timeoutPolicy.onTimeout;
  }

  async run(): Promise<PipelineVoiceLoopResult> {
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

    this.#abortActive(sttError ? "stt_error" : sttEnded ? "stt_ended" : endReason);
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
        if (event.type === "barge_in.detected" && this.#active?.speaking) {
          await this.#interrupt("barge_in");
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
    for await (const event of events) {
      if (this.#active?.speaking && event.text.trim().length > 0) {
        await this.#interrupt("barge_in");
      }
      const transcript = this.#policy.acceptTranscript(event);
      if (transcript) {
        this.#turnChain = this.#turnChain.then(() => this.#handleTranscript(transcript));
      }
    }
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
    };
    this.#active = control;
    const latency: MutableTurnLatency = {};
    let finalText = "";
    const toolCallIds: ToolCallId[] = [];

    try {
      const messages = this.#policy.messagesForTranscript(transcript);
      const first = await this.#runLlm(turn, messages, control, latency);
      finalText = first.text;

      if (!control.abort.signal.aborted && first.toolCalls.length > 0) {
        const tools = await this.#executeToolCalls(turn, first.toolCalls, control, latency);
        toolCallIds.push(...tools.toolCallIds);
        if (!control.abort.signal.aborted) {
          const continuation = await this.#runLlm(
            turn,
            this.#policy.messagesForToolContinuation(messages, first.text, tools.messages),
            control,
            latency,
          );
          finalText = continuation.text;
        }
      }

      if (!control.abort.signal.aborted) {
        await this.#speak(turn, finalText, control, latency);
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
    control.abort.abort();
    if (this.#options.agent.interruptionPolicy.cancelOutputOnInterrupt) {
      await this.#clearOutput(cause);
    }
  }

  async #clearOutput(cause: "barge_in" | "dtmf" | "explicit" | "timeout"): Promise<void> {
    await withTimeout(this.#options.callHandle.cancelOutput(cause), CLEAR_TIMEOUT_MS).catch(
      () => undefined,
    );
  }

  async #runLlm(
    turn: Turn,
    messages: readonly LlmMessage[],
    control: ActiveTurnControl,
    latency: MutableTurnLatency,
  ): Promise<{ readonly text: string; readonly toolCalls: readonly LlmInlineToolCall[] }> {
    let text = "";
    const toolCalls: LlmInlineToolCall[] = [];
    const seenToolRefs = new Set<string>();
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
      } else if (event.type === "llm.tool_call") {
        toolCalls.push(event.call);
        seenToolRefs.add(event.call.callRef);
      } else if (event.type === "llm.completed") {
        text ||= event.text;
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

    let committedMarkId: string | null = null;
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
      return;
    }

    const iterator = stream.events[Symbol.asyncIterator]();
    const aborted = abortPromise(control.abort.signal);
    while (true) {
      const stall = stallTimer(this.#stallTimeoutMs);
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

  async #updateMemory(transcript: string, assistantText: string): Promise<void> {
    const memory = this.#options.memory;
    const policy = this.#options.agent.memoryPolicy;
    if (!memory || !policy.enabled || policy.readOnly || !policy.scopes.includes("session")) {
      return;
    }
    const ref: MemoryRef = { scope: "session", sessionId: this.#options.session.id };
    await memory.append(ref, "exchanges", { user: transcript, assistant: assistantText });
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
