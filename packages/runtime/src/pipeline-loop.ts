import { InMemoryToolIdempotencyStore } from "@tvic/tools";
import { AsyncQueue } from "@tvic/media";
import {
  BackendUnavailableError,
  cancelledError,
  createDefaultIdGenerator,
  evaluateProviderCompatibility,
  internalError,
  normalizeUnknownError,
  timeoutError,
  validationError,
  TvicThrowableError,
  RUNTIME_OBSERVATION_NAMES,
  providerError,
  STT_ERROR_CODES,
} from "@tvic/core";
import type {
  ActiveSession,
  Agent,
  AgentProviders,
  AudioTapSummary,
  CallHandle,
  IdGenerator,
  InputAudioChunk,
  Memory,
  NormalizedError,
  QueuedToolCall,
  Runtime,
  RuntimePipelineObservationInput,
  RuntimePipelineObservationName,
  SessionAttachment,
  SttStream,
  SttUsageReporter,
  ToolCallId,
  TerminalToolCall,
  TerminalTurn,
  ToolIdempotencyStore,
  Turn,
  TurnId,
  TurnTakingProfile,
  UsageModelOrigin,
  TurnOutputDelivery,
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
import {
  assertResolvedTtsCallSelection,
  resolveTtsCallSelection,
  withTtsCallCapabilityContext,
  type TtsCallSelection,
} from "./tts-selection.js";
import { resolveSttCallSelection, type SttCallSelection } from "./stt-selection.js";
import { boundSttAgentContext } from "./stt-agent-context.js";
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
import type { PendingAudioTapSendTracking } from "./pipeline-tts-playback.js";
import {
  AUDIO_TAP_MAX_BUFFERED_CONTROL_EVENTS,
  AUDIO_TAP_MAX_PENDING_SEND_TURNS,
  AudioTapDispatcher,
} from "./audio-tap.js";
import type { AudioTapOptions } from "./audio-tap.js";
import { DualProtocolResultImpl } from "./dual-protocol-result.js";
import { PipelineVoiceLoopBuilder } from "./pipeline-loop-builder.js";
import type { DualProtocolResult, VoiceEvent } from "./voice-event.js";
import { drainAsyncIterator } from "./pipeline-loop-boundary.js";
import { PipelineTerminalCoordinator } from "./pipeline-terminal-boundary.js";
import { recordRuntimePipelineObservation } from "./runtime-observation-capability.js";
import type { LiveTerminalSource } from "./terminal-arbitration.js";
import type {
  ActiveTurnControl,
  MutableTurnLatency,
  TurnLatencyRecord,
  UtteranceTiming,
} from "./turn-state.js";
import type { RuntimeAudioTapHooks } from "./runtime-support.js";
import type { RuntimeUsageHooks } from "./runtime-support.js";
import { SessionUsageAccumulator } from "./session-usage.js";
export type { TurnLatencyRecord } from "./turn-state.js";

interface AudioTapClearObservation {
  readonly turnId?: TurnId;
  readonly throughSequence?: number | undefined;
  readonly fallbackTimestampMs?: number | undefined;
  readonly hadPendingSends: boolean;
  readonly pendingSendTurnIds?: readonly TurnId[];
  readonly pendingSendTurnIdsTruncated?: boolean;
}

function turnOutputDelivery(
  control: ActiveTurnControl,
  textDelivered: boolean | undefined,
): TurnOutputDelivery {
  return {
    audio: control.audioDelivery,
    text:
      textDelivered === undefined
        ? "not_attempted"
        : textDelivered
          ? "transport_accepted"
          : "not_accepted",
  };
}

export interface PipelineVoiceLoopOptions {
  readonly runtime: Runtime;
  readonly session: ActiveSession;
  readonly attachment?: SessionAttachment;
  readonly agent: Agent;
  readonly callHandle: CallHandle;
  readonly llmModel: string;
  readonly llmModelSource?: UsageModelOrigin;
  readonly sttModel?: string;
  readonly sttModelSource?: UsageModelOrigin;
  readonly sttAllowUnknownModel?: boolean;
  readonly sttReconnect?: boolean | SttReconnectOptions;
  readonly sttLanguage?: string;
  readonly turnProfile?: TurnTakingProfile;
  readonly sttLanguagePolicy?: import("@tvic/core").SttLanguagePolicy;
  readonly sttVocabulary?: readonly string[];
  readonly sttConversationContext?: boolean;
  readonly sttSelection?: SttCallSelection;
  readonly includeToolNamesInSttVocabulary?: boolean;
  readonly ttsVoice?: string;
  readonly ttsModel?: string;
  readonly ttsModelSource?: UsageModelOrigin;
  readonly ttsLanguage?: string;
  readonly ttsSpeed?: number;
  readonly ttsVoicesByLanguage?: Readonly<Record<string, string>>;
  readonly ttsTextControls?: readonly import("@tvic/core").TtsTextControl[];
  readonly ttsProviderCapabilitySnapshots?: readonly import("@tvic/core").ProviderCapabilitySnapshot[];
  readonly providerCapabilityEvaluationTimeMs?: number;
  readonly ttsSelection?: TtsCallSelection;
  readonly idGenerator?: IdGenerator;
  readonly conversationPolicy?: ConversationPolicy;
  readonly memory?: Memory;
  readonly memoryUserId?: UserId;
  readonly organizationId?: import("@tvic/core").OrganizationId;
  readonly workflowId?: import("@tvic/core").WorkflowId;
  readonly preCallContext?: import("@tvic/core").PreCallContext;
  readonly safetyIdentifier?: string;
  readonly textDelivery?: TextDeliveryMode;
  readonly streamStallTimeoutMs?: number;
  readonly turnEndpointTimeoutMs?: number;
  readonly turnMaxDurationMs?: number;
  readonly terminalSourceForCancellation?: () => LiveTerminalSource | undefined;
  readonly onTurnLatency?: (record: TurnLatencyRecord) => void;
  readonly onAssistantText?: (record: AssistantTextRecord) => void;
  readonly sessionMetricsRecorder?: import("@tvic/core").SessionMetricsRecorder;
  readonly audioTap?: AudioTapOptions;
  readonly usageAccumulator?: SessionUsageAccumulator;
}

interface PipelineVoiceLoopInternalOptions extends PipelineVoiceLoopOptions {
  readonly onAudioTapSummary?: (summary: AudioTapSummary) => void;
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
  readonly terminalReason: PipelineVoiceLoopTerminalReason;
  readonly terminalSource: LiveTerminalSource;
  readonly audioTap?: AudioTapSummary;
}

type PipelineVoiceLoopCoreResult = Omit<PipelineVoiceLoopResult, "audioTap">;

export class PipelineVoiceLoop {
  readonly #options: PipelineVoiceLoopInternalOptions;
  readonly #providers: AgentProviders;
  readonly #sttSelection: SttCallSelection;
  #sttCommandController: SttCommandController | undefined;
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
  readonly #reportedSttContextErrors = new WeakSet<object>();
  #removeRecoveryListener: (() => void) | undefined;
  #removeRecoveryContextErrorListener: (() => void) | undefined;
  readonly #sttInput: PipelineSttInput;
  #persistenceDegraded = false;
  #persistenceGate: Promise<boolean> = Promise.resolve(true);
  readonly #memoryUserId: UserId | undefined;
  readonly #organizationId: OrganizationId | undefined;
  readonly #workflowId: WorkflowId | undefined;
  readonly #memory: Memory | undefined;
  readonly #terminal: PipelineTerminalCoordinator;
  readonly #audioTap: AudioTapDispatcher;
  readonly #usage: SessionUsageAccumulator;
  readonly #pendingAudioTapOperations = new Set<Promise<void>>();
  readonly #pendingAudioTapClears = new Set<Promise<void>>();
  readonly #pendingAudioTapSendCloseCallbacks = new Set<() => void>();
  readonly #pendingAudioTapSendTurnCounts = new Map<TurnId, number>();
  #pendingAudioTapSendCount = 0;
  #untrackedAudioTapSendCount = 0;
  #audioTapSummary: AudioTapSummary | undefined;
  #audioTapFinishPromise: Promise<AudioTapSummary> | undefined;
  #lastAudioTapTimestampMs = 0;
  #lastAudioTapClockObservationMs = globalThis.performance.now();
  constructor(options: PipelineVoiceLoopOptions) {
    if (options.turnProfile !== undefined) {
      const provider = options.agent.providers.stt;
      const compatibility = evaluateProviderCompatibility(provider, {
        kind: "stt",
        ...((options.sttModel ?? provider.configuredModel)
          ? { model: options.sttModel ?? provider.configuredModel }
          : {}),
        turnProfile: options.turnProfile,
      });
      if (!compatibility.compatible) {
        const details = compatibility.issues
          .map(({ code, requirement }) => `${code}:${requirement}`)
          .join(", ");
        throw TvicThrowableError.from(
          validationError(
            "stt.provider_incompatible",
            `${provider.name} is incompatible with this STT session: ${details}`,
            {
              metadata: {
                provider: provider.name,
                kind: provider.kind,
                issues: compatibility.issues,
              },
            },
          ),
        );
      }
    }
    const sttSelection = resolveSttCallSelection(
      options.agent.providers.stt,
      options.sttSelection
        ? {
            ...(options.sttModel !== undefined ? { model: options.sttModel } : {}),
            ...(options.sttAllowUnknownModel ? { allowUnknownModel: true } : {}),
            ...(options.sttSelection.language !== undefined
              ? { sttLanguage: options.sttSelection.language }
              : {}),
            ...(options.sttSelection.languagePolicy !== undefined
              ? { sttLanguagePolicy: options.sttSelection.languagePolicy }
              : {}),
            ...(options.sttSelection.vocabulary !== undefined
              ? { vocabulary: options.sttSelection.vocabulary }
              : {}),
            sttConversationContext: options.sttSelection.agentContextUpdates,
          }
        : {
            ...(options.sttModel !== undefined ? { model: options.sttModel } : {}),
            ...(options.sttAllowUnknownModel ? { allowUnknownModel: true } : {}),
            ...(options.sttLanguage !== undefined ? { sttLanguage: options.sttLanguage } : {}),
            ...(options.sttLanguagePolicy !== undefined
              ? { sttLanguagePolicy: options.sttLanguagePolicy }
              : {}),
            ...(options.sttConversationContext !== undefined
              ? { sttConversationContext: options.sttConversationContext }
              : {}),
            ...((options.sttVocabulary !== undefined ||
              options.includeToolNamesInSttVocabulary) && {
              vocabulary: [
                ...(options.sttVocabulary ?? []),
                ...(options.includeToolNamesInSttVocabulary
                  ? options.agent.tools.map((tool) => String(tool.name))
                  : []),
              ],
            }),
          },
    );
    if (options.ttsSelection !== undefined) {
      assertResolvedTtsCallSelection(options.ttsSelection, options.agent.providers.tts);
    }
    const requestedCapabilityContext = {
      ...(options.ttsTextControls !== undefined ? { textControls: options.ttsTextControls } : {}),
      ...(options.ttsProviderCapabilitySnapshots !== undefined
        ? { providerCapabilitySnapshots: options.ttsProviderCapabilitySnapshots }
        : {}),
      ...(options.providerCapabilityEvaluationTimeMs !== undefined
        ? { providerCapabilityEvaluationTimeMs: options.providerCapabilityEvaluationTimeMs }
        : {}),
    };
    const ttsSelection =
      options.ttsSelection !== undefined
        ? withTtsCallCapabilityContext(options.ttsSelection, requestedCapabilityContext)
        : resolveTtsCallSelection(options.agent.providers.tts, {
            ...(options.ttsModel !== undefined ? { model: options.ttsModel } : {}),
            ...(options.ttsModelSource !== undefined
              ? { modelSource: options.ttsModelSource }
              : {}),
            ...(options.ttsVoice !== undefined ? { voice: options.ttsVoice } : {}),
            ...(options.ttsLanguage !== undefined ? { language: options.ttsLanguage } : {}),
            ...(options.ttsSpeed !== undefined ? { speed: options.ttsSpeed } : {}),
            ...(options.ttsVoicesByLanguage !== undefined
              ? { voicesByLanguage: options.ttsVoicesByLanguage }
              : {}),
            ...requestedCapabilityContext,
          });
    const normalizedLoopOptions = { ...options };
    delete normalizedLoopOptions.ttsModel;
    delete normalizedLoopOptions.ttsModelSource;
    delete normalizedLoopOptions.ttsVoice;
    delete normalizedLoopOptions.ttsLanguage;
    delete normalizedLoopOptions.ttsSpeed;
    delete normalizedLoopOptions.ttsVoicesByLanguage;
    delete normalizedLoopOptions.ttsTextControls;
    delete normalizedLoopOptions.ttsProviderCapabilitySnapshots;
    delete normalizedLoopOptions.providerCapabilityEvaluationTimeMs;
    this.#options = {
      ...normalizedLoopOptions,
      ...(ttsSelection.model !== undefined ? { ttsModel: ttsSelection.model } : {}),
      ttsModelSource: ttsSelection.modelSource,
      ...(ttsSelection.voice !== undefined ? { ttsVoice: ttsSelection.voice } : {}),
      ...(ttsSelection.language !== undefined ? { ttsLanguage: ttsSelection.language } : {}),
      ...(ttsSelection.speed !== undefined ? { ttsSpeed: ttsSelection.speed } : {}),
      ttsSelection,
    } as PipelineVoiceLoopInternalOptions;
    let usage = options.usageAccumulator ?? new SessionUsageAccumulator();
    if (!options.usageAccumulator) {
      const runtimeUsageHooks = options.runtime as Runtime & RuntimeUsageHooks;
      usage =
        runtimeUsageHooks.registerUsageFinalizer?.(
          options.session.id,
          () => usage.freeze(),
          usage,
        ) ?? usage;
    }
    this.#usage = usage;
    this.#sttSelection = sttSelection;
    this.#audioTap = new AudioTapDispatcher({
      sessionId: options.session.id,
      ...(options.audioTap ? { tap: options.audioTap } : {}),
    });
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
        if (this.#inputEnded) return;
        const runTurn = (): Promise<void> => this.#handleTranscript(transcript, timing);
        this.#turnChain = this.#turnChain.then(runTurn, runTurn);
      },
      ...(options.audioTap
        ? {
            onAudioChunk: (chunk: import("@tvic/core").InputAudioChunk) => {
              this.#audioTap.audio({
                direction: "caller",
                ...(this.#active ? { turnId: this.#active.turnId } : {}),
                bytes: chunk.audio.bytes,
                format: chunk.audio.format,
                timestampMs: this.#audioTapTimestampMs(),
              });
            },
          }
        : {}),
      interrupt: (cause) => this.#interrupt(cause),
      onIteratorTimeout: () => this.#cancellationTimeout("stt.iterator.return"),
    });
    this.#turnOutput = new PipelineTurnOutput({
      options: this.#options,
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
      audioTapTimestampMs: () => this.#audioTapTimestampMs(),
      trackAudioTapOperation: () => this.#trackAudioTapOperation(),
      trackPendingAudioTapSend: (turnId, onTapClose) =>
        this.#trackPendingAudioTapSend(turnId, onTapClose),
      abortActive: (reason) => this.#abortActive(reason),
      cancellationTimeout: (stage) => this.#cancellationTimeout(stage),
      audioTap: this.#audioTap,
      usage: this.#usage,
      submitSttAgentContext: (context) => this.#submitSttAgentContext(context),
    });
    try {
      const runtimeAudioTapHooks = options.runtime as Runtime & RuntimeAudioTapHooks;
      runtimeAudioTapHooks.registerAudioTapFinalizer?.(options.session.id, () =>
        this.#finalizeAudioTapForSessionEnd(),
      );
    } catch {}
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
  start(options: { readonly overrideSignal?: AbortSignal } = {}): PipelineVoiceLoopBuilder {
    return new PipelineVoiceLoopBuilder(this, options.overrideSignal);
  }

  async run(
    options: { readonly overrideSignal?: AbortSignal } = {},
  ): Promise<PipelineVoiceLoopResult> {
    const result = this.start(options);
    return await result;
  }

  _startInternal(options: {
    readonly overrideSignal?: AbortSignal;
    readonly consumer?: "internal" | "public";
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
    const unregisterRuntimeRun = this.#options.runtime.registerPipelineRun?.(
      runPromise,
      cancel,
      this.#options.session.id,
    );
    if (unregisterRuntimeRun) {
      void runPromise.then(unregisterRuntimeRun, unregisterRuntimeRun);
    }
    return result;
  }

  #emitVoiceEvent(event: VoiceEvent): void {
    const queue = this.#runEvents;
    if (!queue) return;
    let bounded = event;
    if (event.kind === "error") {
      bounded = { ...event, error: truncateErrorCause(event.error) };
    } else if (event.kind === "tool_call") {
      bounded = { ...event, input: truncateToolInput(event.input) };
    }
    if (!queue.push(bounded) && !queue.isClosed) {
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

  #emitSttContextUpdateError(error: NormalizedError, recoverable: boolean): void {
    if (this.#reportedSttContextErrors.has(error)) return;
    this.#reportedSttContextErrors.add(error);
    this.#emitVoiceEvent({ kind: "error", error, recoverable });
  }

  #submitSttAgentContext(context: string): void {
    if (!this.#sttSelection.agentContextUpdates) return;
    if (
      this.#inputEnded ||
      this.#runCancelled ||
      this.#shutdownReason !== null ||
      this.#effectiveSignal()?.aborted
    ) {
      return;
    }
    const controller = this.#sttCommandController;
    if (!controller) {
      this.#emitSttContextUpdateError(
        providerError(
          STT_ERROR_CODES.contextUpdateFailed,
          "STT conversation context could not be queued",
          { provider: this.#providers.stt.name, retriable: true },
        ),
        true,
      );
      return;
    }
    void controller.admitAgentContext(boundSttAgentContext(context)).catch((error: unknown) => {
      if (
        this.#inputEnded ||
        this.#runCancelled ||
        this.#shutdownReason !== null ||
        this.#effectiveSignal()?.aborted
      ) {
        return;
      }
      const normalized = normalizeUnknownError(error, {
        code: STT_ERROR_CODES.contextUpdateFailed,
        category: "provider",
        provider: this.#providers.stt.name,
        retriable: true,
      });
      // Context is an optional hint; a rejected update is reported while the
      // voice call continues, even when the provider classifies the cause as
      // non-retriable. That classification still controls reconnect behavior.
      this.#emitSttContextUpdateError(normalized, true);
    });
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
        audioTap: await this.#finishAudioTap(),
      });
      return;
    } catch (err) {
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
      if (normalized.code === STT_ERROR_CODES.contextUpdateFailed) {
        this.#emitSttContextUpdateError(normalized, !cancelled && normalized.retriable);
      } else {
        this.#emitVoiceEvent({
          kind: "error",
          error: normalized,
          recoverable: !cancelled && normalized.retriable,
        });
      }
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
      rejectRun(TvicThrowableError.from(normalized));
    } finally {
      await this.#finishAudioTap();
      this.#removeRunAbortListener?.();
      this.#removeRunAbortListener = undefined;
      this.#runOverrideSignal = undefined;
      this.#runSupervisor = undefined;
      this.#runEvents = undefined;
    }
  }

  async #runLegacy(_events: AsyncQueue<VoiceEvent>): Promise<PipelineVoiceLoopCoreResult> {
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
    const sttModel = this.#options.sttModel ?? this.#providers.stt.configuredModel;
    const sttModelSource =
      this.#options.sttModelSource ??
      (this.#options.sttModel
        ? "request"
        : sttModel && sttModel === this.#providers.stt.configuredModel
          ? "configured"
          : "not_reported");
    const sttUsageReporter: SttUsageReporter = {
      report: (observation) =>
        this.#usage.reportProviderUsage(
          "stt",
          this.#providers.stt.name,
          observation,
          sttModel,
          observation.modelSource === "provider_reported" ? "provider_reported" : sttModelSource,
        ),
      beginOperation: (input) =>
        this.#usage.beginProviderUsage(
          "stt",
          this.#providers.stt.name,
          {
            ...input,
            modelSource:
              input.modelSource === "provider_reported" ? "provider_reported" : sttModelSource,
          },
          sttModel,
        ),
      beginAudioWrite: ({ byteLength, format }) =>
        this.#usage.beginSttAudioWrite({
          provider: this.#providers.stt.name,
          ...(sttModel ? { model: sttModel } : {}),
          modelSource: sttModelSource,
          byteLength,
          format,
        }),
    };
    let stt: SttStream;
    let opening: Promise<SttStream> | undefined;

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
      } catch {}
    }
    try {
      opening = sttProvider.open({
        sessionId: this.#options.session.id,
        format: this.#options.agent.audioPolicy.input,
        ...(sttModel !== undefined ? { model: sttModel } : {}),
        ...(this.#options.sttAllowUnknownModel ? { allowUnknownModel: true } : {}),
        ...(this.#sttSelection.language !== undefined
          ? { language: this.#sttSelection.language }
          : {}),
        ...(this.#options.turnProfile !== undefined
          ? { turnProfile: this.#options.turnProfile }
          : {}),
        ...(this.#sttSelection.languagePolicy
          ? { languagePolicy: this.#sttSelection.languagePolicy }
          : {}),
        interimResults: true,
        ...(this.#sttSelection.vocabulary ? { vocabulary: this.#sttSelection.vocabulary } : {}),
        ...(this.#options.agent.metadata ? { metadata: this.#options.agent.metadata } : {}),
        usageReporter: sttUsageReporter,
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
        ...(sttProvider.usageAccounting?.reportsAudioWrites
          ? {}
          : {
              onAudioWrite: (chunk: InputAudioChunk) =>
                sttUsageReporter.beginAudioWrite({
                  byteLength: chunk.audio.bytes.byteLength,
                  format: chunk.audio.format,
                }),
            }),
      });
    this.#sttCommandController = commandController;
    this.#removeRecoveryListener = recovery?.subscribe((state) =>
      this.#sttInput.setRecoveryState(state),
    );
    this.#removeRecoveryContextErrorListener = recovery?.subscribeContextUpdateError?.((error) =>
      this.#emitSttContextUpdateError(error, true),
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
          sttError ??= error;
          supervisor.abort();
        }
      }
      const straggler = this.#sttInput.flushTrailing();
      if (straggler) {
        const runStraggler = (): Promise<void> =>
          this.#handleTranscript(straggler, {
            endpointAtMs: this.#sttInput.wallNow(),
          });
        this.#turnChain = this.#turnChain.then(runStraggler, runStraggler);
      }
      this.#inputEnded = true;
    } else {
      supervisor.abort(sttError ?? new Error("STT input ended"));
      await cancelWithTimeout(
        () => commandController.abort(sttError ?? new Error("STT input ended")),
        pipelineConstants.CANCELLATION_TIMEOUT_MS,
        () => this.#cancellationTimeout("stt.abort"),
      ).catch(() => undefined);
    }

    if (sttError) {
      this.#shutdownReason = "stt_error";
    }
    if (!gracefulEnd || sttError) {
      this.#abortActive(this.#shutdownReason);
    }
    this.#sttInput.cancelBargeInCandidate();
    this.#removeRecoveryListener?.();
    this.#removeRecoveryListener = undefined;
    this.#removeRecoveryContextErrorListener?.();
    this.#removeRecoveryContextErrorListener = undefined;
    this.#sttCommandController = undefined;
    detachSupervisorSignal();
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

    const startedAtMs = timing.endpointAtMs;
    const control: ActiveTurnControl = {
      turnId: turn.id,
      abort: new AbortController(),
      startedAtMs,
      interruptedAtMs: null,
      interruptionTailMs: null,
      cancelReason: "barge_in",
      outputFramesSent: 0,
      audioDelivery: "not_attempted",
      speaking: false,
      outputDelivered: false,
      alignedTokens: [],
      alignedTokenBytes: 0,
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
    this.#recordObservation(
      RUNTIME_OBSERVATION_NAMES.TURN_START,
      turn.id,
      {
        turn_sequence: turn.sequence,
        ...(timing.listenedMs !== undefined ? { listened_ms: timing.listenedMs } : {}),
        ...(timing.endpointMs !== undefined ? { endpoint_ms: timing.endpointMs } : {}),
      },
      timing.endpointAtMs,
    );
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
            const timestampMs = this.#options.audioTap ? this.#audioTapTimestampMs() : undefined;
            void this.#clearOutput(control.turnId, timestampMs);
          };
          this.#options.attachment.signal.addEventListener("abort", clear, { once: true });
          return () => this.#options.attachment?.signal?.removeEventListener("abort", clear);
        })()
      : () => undefined;
    this.#active = control;
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
        delivery: turnOutputDelivery(control, textDelivered),
      });
    };
    let finalText = "";
    let audioError: NormalizedError | null = null;
    let textDelivered: boolean | undefined;
    let audioDelivered = false;
    let incrementalFailure: unknown = null;
    let speakingPersisted = false;
    const toolCallIds: ToolCallId[] = [];
    const incrementalOutput = this.#turnOutput.incrementalTtsInput(turn, control);
    const incrementalInput = incrementalOutput?.input ?? null;
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
            this.#policy.messagesForToolContinuation(
              messages,
              first.text,
              tools.messages,
              tools.assistantToolCalls,
            ),
            control,
            latency,
            onLlmText,
          );
          finalText = continuation.text;
        }
      }

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
            incrementalOutput?.playbackCompleted();
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

      const cancelledByBargeIn =
        control.interruptedAtMs !== null && control.cancelReason === "barge_in";
      textDelivered =
        !control.abort.signal.aborted || cancelledByBargeIn || audioError !== null
          ? await deliverAssistantText({
              callHandle: this.#options.callHandle,
              turn,
              text: finalText,
              ...(this.#options.textDelivery ? { mode: this.#options.textDelivery } : {}),
              audioDelivered,
              cancelledByBargeIn,
            })
          : undefined;
      control.outputDelivered = audioDelivered || textDelivered === true;
      latency.totalMs = this.#durationSince(startedAtMs);

      if (!control.outputDelivered) {
        const interruptedText =
          control.interruptedAtMs !== null && control.cancelReason === "barge_in"
            ? control.alignedDurationMs > 0
              ? alignedTextForHistory(control)
              : ""
            : undefined;
        if (interruptedText !== undefined) this.#submitSttAgentContext(interruptedText);
        if (control.interruptionTailMs !== null) {
          latency.interruptionTailMs = control.interruptionTailMs;
        }
        let terminal: TerminalTurn;
        try {
          terminal = await this.#options.runtime.endTurn(this.#options.session.id, turn.id, {
            reason: "cancelled",
            cancelReason: control.interruptedAtMs !== null ? control.cancelReason : "not_heard",
            output: {
              text: finalText,
              mediaEventIds: [],
              delivery: turnOutputDelivery(control, textDelivered),
            },
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
            audioDelivered,
            audioError,
            latency,
            startedAtMs,
            errorEvent: terminal.status === "failed" ? terminal.error : undefined,
            emitTurnCompleted,
          });
          return;
        }
        if (control.interruptedAtMs !== null && control.cancelReason === "barge_in") {
          const memoryText = interruptedText || finalText;
          this.#policy.recordInterruptedTurn(transcript, memoryText);
          await this.#updateMemory(turn.id, transcript, memoryText, true).catch(() => undefined);
        }
        this.#observeTerminalTurn({
          turn,
          terminal,
          status: "cancelled",
          finalText,
          textDelivered,
          audioDelivered,
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
          output: {
            text: finalText,
            mediaEventIds: [],
            delivery: turnOutputDelivery(control, textDelivered),
          },
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
          audioDelivered,
          audioError,
          latency,
          startedAtMs,
          errorEvent: terminal.status === "failed" ? terminal.error : undefined,
          emitTurnCompleted,
        });
        return;
      }
      this.#policy.recordTurn(transcript, finalText);
      this.#recordTerminalObservation({
        turn,
        terminal,
        status: "completed",
        textDelivered,
        audioDelivered,
        audioError,
        latency,
      });
      await this.#updateMemory(turn.id, transcript, finalText).catch(() => undefined);
      this.#observeTerminalTurn({
        turn,
        terminal,
        status: "completed",
        finalText,
        textDelivered,
        audioDelivered,
        audioError,
        latency,
        startedAtMs,
        emitTurnCompleted,
        runtimeObservationRecorded: true,
      });
    } catch (error) {
      latency.totalMs = this.#durationSince(startedAtMs);
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
            output: {
              text: finalText,
              mediaEventIds: [],
              delivery: turnOutputDelivery(control, textDelivered),
            },
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
        if (terminal.status === "completed") {
          this.#policy.recordTurn(transcript, finalText);
        }
        this.#recordTerminalObservation({
          turn,
          terminal,
          status: terminal.status,
          textDelivered,
          audioDelivered,
          audioError,
          latency,
        });
        if (terminal.status === "completed") {
          await this.#updateMemory(turn.id, transcript, finalText).catch(() => undefined);
        }
        this.#observeTerminalTurn({
          turn,
          terminal,
          status: terminal.status,
          finalText,
          textDelivered,
          audioDelivered,
          audioError,
          latency,
          startedAtMs,
          emitTurnCompleted,
          runtimeObservationRecorded: true,
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
        audioDelivered,
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
    } catch {}
    try {
      this.#options.sessionMetricsRecorder?.onTurn(turn, this.#options.session.id);
    } catch {}
  }

  #recordTerminalObservation(observation: {
    readonly turn: Turn;
    readonly terminal: TerminalTurn | undefined;
    readonly status: "completed" | "cancelled" | "failed";
    readonly textDelivered: boolean | undefined;
    readonly audioDelivered: boolean;
    readonly audioError: NormalizedError | null;
    readonly latency: MutableTurnLatency;
    readonly errorEvent?: NormalizedError | undefined;
  }): void {
    const { turn, terminal, status } = observation;
    const attributes: Record<string, string | number | boolean> = {
      status: terminal?.status ?? status,
      turn_sequence: terminal?.sequence ?? turn.sequence,
      audio_delivered: observation.audioDelivered,
      terminal_persisted: terminal !== undefined,
    };
    const latency = terminal?.latency ?? observation.latency;
    if (latency.listenedMs !== undefined) attributes.listened_ms = latency.listenedMs;
    if (latency.endpointMs !== undefined) attributes.endpoint_ms = latency.endpointMs;
    if (latency.firstTokenMs !== undefined) attributes.first_token_ms = latency.firstTokenMs;
    if (latency.firstAudioMs !== undefined) attributes.first_audio_ms = latency.firstAudioMs;
    if (latency.toolMs !== undefined) attributes.tool_ms = latency.toolMs;
    if (latency.interruptionTailMs !== undefined) {
      attributes.interruption_tail_ms = latency.interruptionTailMs;
    }
    if (latency.totalMs !== undefined) attributes.total_ms = latency.totalMs;
    if ("recoveryGapMs" in latency && latency.recoveryGapMs !== undefined) {
      attributes.recovery_gap_ms = latency.recoveryGapMs;
    }
    if (observation.textDelivered !== undefined) {
      attributes.text_delivered = observation.textDelivered;
    }
    if (observation.audioError) {
      attributes.audio_error_code = observation.audioError.code;
    }
    if (terminal?.status === "cancelled") attributes.cancel_reason = terminal.reason;
    const errorEvent = terminal?.status === "failed" ? terminal.error : observation.errorEvent;
    if (errorEvent) {
      attributes.error_code = errorEvent.code;
      attributes.error_category = errorEvent.category;
      attributes.error_retriable = errorEvent.retriable;
    }
    this.#recordObservation(RUNTIME_OBSERVATION_NAMES.TURN_END, turn.id, attributes);
  }

  #observeTerminalTurn(observation: {
    readonly turn: Turn;
    readonly terminal: TerminalTurn | undefined;
    readonly status: "completed" | "cancelled" | "failed";
    readonly finalText: string;
    readonly textDelivered: boolean | undefined;
    readonly audioDelivered: boolean;
    readonly audioError: NormalizedError | null;
    readonly latency: MutableTurnLatency;
    readonly startedAtMs: number;
    readonly errorEvent?: NormalizedError | undefined;
    readonly emitTurnCompleted: (status: TerminalTurn["status"]) => void;
    readonly runtimeObservationRecorded?: boolean;
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
    if (terminal) {
      this.#recordTerminalTurn(terminal);
    }
    if (!observation.runtimeObservationRecorded) {
      this.#recordTerminalObservation(observation);
    }
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
    this.#recordObservation(RUNTIME_OBSERVATION_NAMES.TURN_INTERRUPTION, control.turnId, { cause });
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
    control.interruptionTailMs = Math.max(0, this.#monotonicMs() - control.interruptedAtMs);
  }

  async #trimOutput(): Promise<void> {
    const turnId = this.#active?.turnId;
    const timestampMs = this.#options.audioTap ? this.#audioTapTimestampMs() : undefined;
    await this.#clearOutput(turnId, timestampMs);
  }

  async #clearOutput(turnId: TurnId | undefined, fallbackTimestampMs?: number): Promise<void> {
    const observation = this.#options.audioTap
      ? {
          ...(turnId ? { turnId } : {}),
          throughSequence: this.#audioTap.agentAudioThroughSequence(),
          fallbackTimestampMs,
          hadPendingSends: this.#pendingAudioTapSendCount > 0,
          ...(this.#pendingAudioTapSendTurnCounts.size > 0
            ? { pendingSendTurnIds: [...this.#pendingAudioTapSendTurnCounts.keys()] }
            : {}),
          ...(this.#untrackedAudioTapSendCount > 0 ? { pendingSendTurnIdsTruncated: true } : {}),
        }
      : undefined;
    const clear = this.#clearTransportOutput();
    if (observation) this.#observeAudioTapClear(clear, observation);
    await withTimeout(clear, pipelineConstants.CLEAR_TIMEOUT_MS).catch(() => undefined);
  }

  #clearTransportOutput(): Promise<boolean> {
    try {
      return Promise.resolve(this.#options.callHandle.clear()).then(
        () => true,
        () => false,
      );
    } catch {
      return Promise.resolve(false);
    }
  }

  #observeAudioTapClear(clear: Promise<boolean>, observation: AudioTapClearObservation): void {
    if (this.#pendingAudioTapClears.size >= AUDIO_TAP_MAX_BUFFERED_CONTROL_EVENTS) {
      this.#audioTap.recordDroppedEvents(1);
      return;
    }

    const loopReference = new WeakRef(this);
    let tracked!: Promise<void>;
    tracked = clear.then((cleared) => {
      const loop = loopReference.deref();
      if (!loop) return;
      loop.#pendingAudioTapClears.delete(tracked);
      if (cleared && loop.#audioTapSummary === undefined) {
        try {
          loop.#recordAudioTapClear(observation);
        } catch {}
      }
    });
    this.#pendingAudioTapClears.add(tracked);
  }

  #recordAudioTapClear(observation: AudioTapClearObservation): void {
    if (!this.#options.audioTap) return;
    this.#audioTap.cleared({
      ...(observation.turnId ? { turnId: observation.turnId } : {}),
      throughSequence: observation.throughSequence,
      hadPendingSends: observation.hadPendingSends,
      ...(observation.pendingSendTurnIds
        ? { pendingSendTurnIds: observation.pendingSendTurnIds }
        : {}),
      ...(observation.pendingSendTurnIdsTruncated ? { pendingSendTurnIdsTruncated: true } : {}),
      timestampMs: Math.max(observation.fallbackTimestampMs ?? 0, this.#audioTapTimestampMs()),
    });
  }

  #trackAudioTapOperation(): () => void {
    return this.#trackPendingOperation(this.#pendingAudioTapOperations);
  }

  #trackPendingAudioTapSend(turnId: TurnId, onTapClose: () => void): PendingAudioTapSendTracking {
    const trackTurnId =
      this.#pendingAudioTapSendTurnCounts.has(turnId) ||
      this.#pendingAudioTapSendTurnCounts.size < AUDIO_TAP_MAX_PENDING_SEND_TURNS;
    if (trackTurnId) {
      this.#pendingAudioTapSendTurnCounts.set(
        turnId,
        (this.#pendingAudioTapSendTurnCounts.get(turnId) ?? 0) + 1,
      );
    } else {
      this.#untrackedAudioTapSendCount += 1;
    }
    this.#pendingAudioTapSendCount += 1;
    this.#pendingAudioTapSendCloseCallbacks.add(onTapClose);

    const loopReference = new WeakRef(this);
    let settled = false;
    let closeCallbackReleased = false;
    const releaseCloseCallback = (): void => {
      if (closeCallbackReleased) return;
      closeCallbackReleased = true;
      const loop = loopReference.deref();
      if (loop) loop.#pendingAudioTapSendCloseCallbacks.delete(onTapClose);
    };
    return {
      releaseCloseCallback,
      release: () => {
        if (settled) return;
        settled = true;
        releaseCloseCallback();
        const loop = loopReference.deref();
        if (loop) {
          loop.#releasePendingAudioTapSend(turnId, trackTurnId);
        }
      },
    };
  }

  #releasePendingAudioTapSend(turnId: TurnId, trackTurnId: boolean): void {
    if (this.#pendingAudioTapSendCount > 0) this.#pendingAudioTapSendCount -= 1;
    if (trackTurnId) {
      const count = this.#pendingAudioTapSendTurnCounts.get(turnId) ?? 0;
      if (count <= 1) this.#pendingAudioTapSendTurnCounts.delete(turnId);
      else this.#pendingAudioTapSendTurnCounts.set(turnId, count - 1);
    } else if (this.#untrackedAudioTapSendCount > 0) {
      this.#untrackedAudioTapSendCount -= 1;
    }
    if (this.#pendingAudioTapSendCount === 0) {
      this.#pendingAudioTapSendTurnCounts.clear();
      this.#untrackedAudioTapSendCount = 0;
    }
  }

  #trackPendingOperation(pending: Set<Promise<void>>): () => void {
    let resolve!: () => void;
    const operation = new Promise<void>((done) => {
      resolve = done;
    });
    pending.add(operation);
    let settled = false;
    return () => {
      if (settled) return;
      settled = true;
      pending.delete(operation);
      resolve();
    };
  }

  #finishAudioTap(): Promise<AudioTapSummary> {
    if (this.#audioTapSummary) return Promise.resolve(this.#audioTapSummary);
    if (this.#audioTapFinishPromise) return this.#audioTapFinishPromise;
    this.#audioTapFinishPromise = (async () => {
      await this.#waitForAudioTapOperations();
      return this.#closeAudioTap();
    })();
    return this.#audioTapFinishPromise;
  }

  #finalizeAudioTapForSessionEnd(): Promise<AudioTapSummary> {
    return Promise.resolve(this.#closeAudioTap());
  }

  #closeAudioTap(): AudioTapSummary {
    if (this.#audioTapSummary) return this.#audioTapSummary;
    for (const release of [...this.#pendingAudioTapSendCloseCallbacks]) {
      try {
        release();
      } catch {}
    }
    this.#pendingAudioTapSendCloseCallbacks.clear();
    if (this.#options.audioTap) {
      this.#audioTap.recordDroppedEvents(this.#pendingAudioTapClears.size);
    }
    const summary = this.#audioTap.close();
    this.#audioTapSummary = summary;
    try {
      const runtimeAudioTapHooks = this.#options.runtime as Runtime & RuntimeAudioTapHooks;
      runtimeAudioTapHooks.reportAudioTapSummary?.(this.#options.session.id, summary);
      runtimeAudioTapHooks.unregisterAudioTapFinalizer?.(this.#options.session.id);
    } catch {}
    try {
      this.#options.onAudioTapSummary?.(summary);
    } catch {}
    return summary;
  }

  async #waitForAudioTapOperations(): Promise<void> {
    await this.#waitForOutputClearsAtSessionEnd();
    const deadline = Date.now() + pipelineConstants.AUDIO_TAP_FINALIZE_TIMEOUT_MS;
    while (this.#pendingAudioTapOperations.size > 0) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = await Promise.race([
        Promise.allSettled([...this.#pendingAudioTapOperations]).then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), remainingMs);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      if (timedOut) {
        this.#pendingAudioTapOperations.clear();
        return;
      }
    }
  }

  async #waitForOutputClearsAtSessionEnd(): Promise<void> {
    const deadline = Date.now() + pipelineConstants.CLEAR_TIMEOUT_MS;
    while (this.#pendingAudioTapClears.size > 0) {
      const timeoutMs = deadline - Date.now();
      if (timeoutMs <= 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...this.#pendingAudioTapClears]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      if (Date.now() >= deadline) return;
    }
  }

  #audioTapTimestampMs(): number {
    try {
      const timestampMs = this.#monotonicMs();
      if (Number.isFinite(timestampMs)) {
        this.#lastAudioTapTimestampMs = Math.max(this.#lastAudioTapTimestampMs, timestampMs);
      }
    } catch {}
    return this.#lastAudioTapTimestampMs;
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
    try {
      const timestampMs = this.#options.runtime.sessionClockMs(this.#options.session.id);
      if (this.#options.audioTap && Number.isFinite(timestampMs)) {
        this.#lastAudioTapTimestampMs = Math.max(this.#lastAudioTapTimestampMs, timestampMs);
        this.#lastAudioTapClockObservationMs = globalThis.performance.now();
      }
      return timestampMs;
    } catch (error) {
      if (this.#options.audioTap) {
        const nowMs = globalThis.performance.now();
        const elapsedMs = Math.max(Number.EPSILON, nowMs - this.#lastAudioTapClockObservationMs);
        this.#lastAudioTapTimestampMs += elapsedMs;
        this.#lastAudioTapClockObservationMs = nowMs;
        return this.#lastAudioTapTimestampMs;
      }
      throw error;
    }
  }

  #recordObservation(
    name: RuntimePipelineObservationName,
    turnId: Turn["id"],
    attributes?: Readonly<Record<string, string | number | boolean>>,
    atMs?: number,
  ): void {
    try {
      const observation: RuntimePipelineObservationInput = {
        name,
        sessionId: this.#options.session.id,
        atMs: atMs ?? this.#monotonicMs(),
        turnId,
        ...(attributes ? { attributes } : {}),
      };
      recordRuntimePipelineObservation(this.#options.runtime, observation);
    } catch {}
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
