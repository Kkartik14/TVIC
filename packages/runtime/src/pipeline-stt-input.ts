import { isInputMediaEvent } from "@tvic/media";
import { isNormalizedError, isTranscriptSegmentEvent, STT_STREAM_ENDED_REASON } from "@tvic/core";
import type {
  CallHandle,
  InterruptionPolicy,
  NormalizedError,
  SttStream,
  TranscriptEvent,
  Turn,
} from "@tvic/core";

import { abortPromise } from "./async-control.js";
import { ConversationPolicy } from "./conversation-policy.js";
import { RecoveryAwareTiming } from "./recovery-timing.js";
import type { SttCommandController } from "./stt-command-controller.js";
import type { SttRecoveryState } from "./resilient-stt.js";
import type { ActiveTurnControl, UtteranceTiming } from "./turn-state.js";

const TRANSCRIPT_FINALIZE_GRACE_MS = 250;
const NEVER = new Promise<never>(() => undefined);

export interface PipelineSttInputOptions {
  readonly callHandle: CallHandle;
  readonly policy: ConversationPolicy;
  readonly interruptionPolicy: InterruptionPolicy;
  readonly endpointTimeoutMs: number;
  readonly maxDurationMs: number;
  readonly now: () => number;
  readonly getActive: () => ActiveTurnControl | null;
  readonly onTranscript: (transcript: string, timing: UtteranceTiming) => void;
  readonly interrupt: (cause: "barge_in" | "explicit" | "dtmf") => Promise<void>;
}

export interface PipelineInputResult {
  readonly endReason: string;
  readonly streamError: NormalizedError | null;
  readonly mediaEnded: boolean;
}

/**
 * Owns STT ingress admission, transcript endpointing, and interruption timing.
 * The voice loop supplies only the turn callback and active-turn seam; provider
 * I/O remains behind the bounded command controller.
 */
export class PipelineSttInput {
  readonly #options: PipelineSttInputOptions;
  readonly #policy: ConversationPolicy;
  readonly #timing: RecoveryAwareTiming;
  readonly pendingCommitFlushes = new Set<Promise<void>>();
  #speechStartedAtMs: number | null = null;
  #lastFinalAtMs: number | null = null;
  #bargeInTimer: ReturnType<typeof setTimeout> | null = null;
  #transcriptActivitySeq = 0;
  #lastTranscriptWasEndpoint = false;
  #speechCandidate:
    | {
        readonly turnId: Turn["id"];
        readonly startedAtMs: number;
        readonly audioOffsetMs?: number;
      }
    | undefined;

  constructor(options: PipelineSttInputOptions) {
    this.#options = options;
    this.#policy = options.policy;
    this.#timing = new RecoveryAwareTiming({
      now: options.now,
      endpointTimeoutMs: options.endpointTimeoutMs,
      maxDurationMs: options.maxDurationMs,
      onEndpoint: () => this.#flushTimedEndpoint(),
    });
  }

  async consumeInput(
    stt: SttStream,
    commandController: SttCommandController,
    signal: AbortSignal,
  ): Promise<PipelineInputResult> {
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
          void commandController.admitAudio(event).catch((error) => {
            if (isSttStreamEndedError(error)) {
              endReason = "stt_error";
              streamError = error;
              mediaEnded = true;
            }
          });
        }
        if (event.type === "media.turn.commit_requested") {
          this.#trackCommitFlush(this.commitAndFlush(stt, commandController, signal));
        }
        if (event.type === "media.interrupt.requested" && this.#options.getActive()?.speaking) {
          await this.#options.interrupt("explicit");
        }
        if (event.type === "dtmf.received" && this.#options.getActive()?.speaking) {
          await this.#options.interrupt("dtmf");
        }
        if (event.type === "media.stream.ended" || event.type === "media.error") {
          mediaEnded = true;
          if (event.type === "media.stream.ended") {
            endReason = event.reason;
          } else {
            endReason = "media_error";
            streamError = event.error;
          }
          break;
        }
      }
    } finally {
      await iterator.return?.().catch(() => undefined);
    }
    return { endReason, streamError, mediaEnded };
  }

  async consumeTranscripts(events: AsyncIterable<TranscriptEvent>): Promise<void> {
    try {
      for await (const event of events) {
        await this.#considerSpeechForBargeIn(event);
        if (event.type === "stt.speech.started") {
          this.#speechStartedAtMs ??= this.#timing.activeNow();
        }
        const transcript = this.#policy.acceptTranscript(event);
        if (event.type === "stt.final") {
          this.#transcriptActivitySeq += 1;
          this.#lastTranscriptWasEndpoint = false;
          this.#lastFinalAtMs = this.#timing.activeNow();
          if (this.#policy.hasBufferedTranscript && this.#timing.isHealthy) {
            this.#armEndpointTimers();
          }
        } else if (event.type === "stt.endpoint") {
          this.#transcriptActivitySeq += 1;
          this.#lastTranscriptWasEndpoint = true;
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

  commitAndFlush(
    stt: SttStream,
    commandController: SttCommandController,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.#commitAndFlush(stt, commandController, signal);
  }

  setRecoveryState(state: SttRecoveryState): void {
    this.#timing.setState(state, this.#policy.hasBufferedTranscript);
    if (state === "healthy") {
      if (this.#speechCandidate && this.#options.getActive()) {
        this.#scheduleBargeInTimer(this.#options.getActive()!);
      }
      return;
    }
    this.#bargeInTimer && clearTimeout(this.#bargeInTimer);
    this.#bargeInTimer = null;
  }

  cancelBargeInCandidate(): void {
    if (this.#bargeInTimer) {
      clearTimeout(this.#bargeInTimer);
      this.#bargeInTimer = null;
    }
    this.#speechCandidate = undefined;
  }

  #trackCommitFlush(flush: Promise<void>): void {
    this.pendingCommitFlushes.add(flush);
    void flush.finally(() => this.pendingCommitFlushes.delete(flush)).catch(() => undefined);
  }

  async #commitAndFlush(
    stt: SttStream,
    commandController: SttCommandController,
    signal?: AbortSignal,
  ): Promise<void> {
    const seqBefore = this.#transcriptActivitySeq;
    await Promise.race([
      commandController.admitCommit(),
      signal ? abortPromise(signal).then(() => undefined) : NEVER,
    ]);
    if (signal?.aborted) {
      return;
    }
    if (stt.commitMode !== "none") {
      await this.#timing.waitForActive(
        () => this.#transcriptActivitySeq > seqBefore && this.#lastTranscriptWasEndpoint,
        TRANSCRIPT_FINALIZE_GRACE_MS,
        signal,
      );
    }
    if (signal?.aborted) {
      return;
    }
    this.#cancelEndpointTimers();
    const trailing = this.#policy.flushBufferedTranscript();
    if (trailing) {
      this.#queueTranscript(trailing);
    }
  }

  #queueTranscript(transcript: string): void {
    this.#options.onTranscript(transcript, this.#takeUtteranceTiming());
  }

  #takeUtteranceTiming(): UtteranceTiming {
    const endpointAtMs = this.#timing.activeNow();
    const speechStartedAtMs = this.#speechStartedAtMs;
    const lastFinalAtMs = this.#lastFinalAtMs;
    this.#speechStartedAtMs = null;
    this.#lastFinalAtMs = null;
    return {
      endpointAtMs,
      ...(speechStartedAtMs !== null
        ? { listenedMs: Math.max(0, endpointAtMs - speechStartedAtMs) }
        : {}),
      ...(lastFinalAtMs !== null ? { endpointMs: Math.max(0, endpointAtMs - lastFinalAtMs) } : {}),
    };
  }

  #armEndpointTimers(): void {
    this.#timing.armEndpointTimers(this.#policy.hasBufferedTranscript);
  }

  #flushTimedEndpoint(): void {
    this.#cancelEndpointTimers();
    const transcript = this.#policy.flushBufferedTranscript();
    if (transcript) {
      this.#queueTranscript(transcript);
    }
  }

  #cancelEndpointTimers(): void {
    this.#timing.cancelEndpointTimers();
  }

  async #considerSpeechForBargeIn(event: TranscriptEvent): Promise<void> {
    if (this.#options.interruptionPolicy.mode === "ignore") {
      this.cancelBargeInCandidate();
      return;
    }
    const active = this.#options.getActive();
    if (!active?.speaking) {
      this.cancelBargeInCandidate();
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
      const activeSpeechMs = candidate ? this.#timing.activeNow() - candidate.startedAtMs : 0;
      if (
        candidate &&
        Math.max(audioSpeechMs, activeSpeechMs) >= this.#options.interruptionPolicy.minSpeechMs
      ) {
        await this.#options.interrupt("barge_in");
      } else {
        this.cancelBargeInCandidate();
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
    const activeSpeechMs = candidate ? this.#timing.activeNow() - candidate.startedAtMs : 0;
    if (Math.max(audioSpeechMs, activeSpeechMs) >= this.#options.interruptionPolicy.minSpeechMs) {
      await this.#options.interrupt("barge_in");
    }
  }

  #startBargeInCandidate(active: ActiveTurnControl, audioOffsetMs?: number): void {
    if (this.#speechCandidate?.turnId === active.turnId) {
      return;
    }
    this.cancelBargeInCandidate();
    this.#speechCandidate = {
      turnId: active.turnId,
      startedAtMs: this.#timing.activeNow(),
      ...(typeof audioOffsetMs === "number" ? { audioOffsetMs } : {}),
    };
    if (this.#options.interruptionPolicy.minSpeechMs <= 0) {
      void this.#options.interrupt("barge_in");
      return;
    }
    this.#scheduleBargeInTimer(active);
  }

  #scheduleBargeInTimer(active: ActiveTurnControl): void {
    if (!this.#speechCandidate || !this.#timing.isHealthy) {
      return;
    }
    if (this.#bargeInTimer) {
      clearTimeout(this.#bargeInTimer);
    }
    const elapsed = Math.max(0, this.#timing.activeNow() - this.#speechCandidate.startedAtMs);
    const remaining = Math.max(0, this.#options.interruptionPolicy.minSpeechMs - elapsed);
    this.#bargeInTimer = setTimeout(() => {
      this.#bargeInTimer = null;
      if (
        this.#timing.isHealthy &&
        this.#options.getActive()?.turnId === active.turnId &&
        this.#options.getActive()?.speaking
      ) {
        void this.#options.interrupt("barge_in");
      }
    }, remaining);
  }
}

function isSttStreamEndedError(error: unknown): error is NormalizedError {
  return isNormalizedError(error) && error.metadata?.reason === STT_STREAM_ENDED_REASON;
}
