import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  ProviderCapabilities,
  TraceEvent,
  TraceEventType,
  TraceExporter,
  TraceQuery,
  TraceRedactor,
  TraceStore,
} from "@tvic/core";

export {
  InMemoryTraceStore,
  LocalCallArtifactWriter,
  callArtifactDirectory,
  createInMemoryTraceStore,
  deleteCallArtifacts,
  pruneExpiredCallArtifacts,
} from "@tvic/dal";
export type {
  AppendAudioArtifactInput,
  DeleteCallArtifactsInput,
  InMemoryTraceStoreOptions,
  LocalCallArtifactWriterOptions,
  PruneExpiredCallArtifactsInput,
} from "@tvic/dal";

export interface JsonlTraceExporterOptions {
  readonly path: string;
  readonly name?: string;
  readonly version?: string;
  readonly redactor?: TraceRedactor;
}

const TRACE_EXPORTER_CAPABILITIES: ProviderCapabilities = {
  streaming: false,
  interruption: false,
};

export class JsonlTraceExporter implements TraceExporter {
  readonly name: string;
  readonly kind = "trace_exporter";
  readonly version: string;
  readonly capabilities = TRACE_EXPORTER_CAPABILITIES;

  readonly #path: string;
  readonly #redactor: TraceRedactor | undefined;
  // All appends funnel through this chain, so concurrent export() calls are serialized
  // (appended in call order) and never interleave on the file. flush()/close() drain it.
  #chain: Promise<void> = Promise.resolve();
  #closed = false;
  #directoryReady = false;

  constructor(options: JsonlTraceExporterOptions) {
    this.name = options.name ?? "jsonl-trace-exporter";
    this.version = options.version ?? "0.1.0";
    this.#path = options.path;
    this.#redactor = options.redactor;
  }

  async export(events: readonly TraceEvent[]): Promise<void> {
    if (this.#closed || events.length === 0) {
      return;
    }

    const redacted = events
      .map((event) => (this.#redactor ? this.#redactor(event) : event))
      .filter((event): event is TraceEvent => event !== null);
    if (redacted.length === 0) {
      return;
    }

    const body = redacted.map((event) => JSON.stringify(event)).join("\n");
    // Per the TraceExporter contract, export() resolves once events are accepted/enqueued
    // (in order) — NOT once durably written. The append is chained behind any in-flight
    // write to preserve ordering; flush()/close() await durability. This keeps disk
    // latency off the realtime trace path, consistent with LocalCallArtifactWriter.
    this.#chain = this.#chain
      .then(async () => {
        await this.#ensureDirectory();
        await appendFile(this.#path, `${body}\n`, "utf8");
      })
      .catch(() => undefined);
  }

  async flush(): Promise<void> {
    await this.#chain;
  }

  async close(): Promise<void> {
    this.#closed = true;
    // Drain every queued append before finalizing, so nothing is lost or reordered.
    await this.#chain;
  }

  async #ensureDirectory(): Promise<void> {
    if (this.#directoryReady) {
      return;
    }
    await mkdir(dirname(this.#path), { recursive: true });
    this.#directoryReady = true;
  }
}

export function traceTypes(events: readonly TraceEvent[]): readonly TraceEventType[] {
  return events.map((event) => event.type);
}

export type { TraceEvent, TraceEventType, TraceQuery, TraceRedactor, TraceStore };
export type { EmitTraceEventOptions } from "./emitter.js";
export { emitTraceEvent } from "./emitter.js";
export { deriveCallTimeline } from "./analysis.js";
export type {
  CallTimeline,
  TimelineInterruption,
  TurnMetrics,
  TurnView,
  TurnViewStatus,
} from "./analysis.js";
export { spanKind } from "./spans.js";
export type { SpanKind, SpanView } from "./spans.js";
export { isTraceEvent, parseTraceJsonl } from "./validate.js";
export { deriveCallInspection } from "./inspection.js";
export type {
  CallInspection,
  CallStatus,
  CallSummary,
  DeriveCallInspectionOptions,
  EvidenceView,
  InterruptionView,
  LatencyBreakdown,
  LlmPassTiming,
  MemoryWriteView,
  PlayoutState,
  PlayoutView,
  RecordingSummary,
  ReplaySegment,
  ReplaySegmentKind,
  ReplayTrack,
  ToolCallView,
  TurnInspection,
  TurnInspectionStatus,
  TurnTag,
} from "./inspection.js";
export {
  buildFailure,
  buildIncident,
  classifyCancelReason,
  classifyError,
  toolErrorIncidentKind,
} from "./failure.js";
export type {
  FailureCategory,
  FailureExplanation,
  FailureKind,
  FailureSeverity,
  IncidentKind,
  IncidentView,
} from "./failure.js";
export type { TraceCoreInput } from "./projection.js";
export {
  audioOutputChunkTrace,
  audioOutputEndedTrace,
  audioOutputStartedTrace,
  bargeInRejectedTrace,
  interruptDetectedTrace,
  interruptHandledTrace,
  llmStreamTrace,
  mediaEventTrace,
  memoryWriteTrace,
  outputCancelledTrace,
  runtimeRetryTrace,
  runtimeTimeoutTrace,
  sessionCreatedTrace,
  sessionEndTrace,
  sessionStartedTrace,
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
  turnEndTrace,
  turnStartedTrace,
} from "./projection.js";
