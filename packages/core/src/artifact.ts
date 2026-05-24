import type { AudioFormat } from "./audio.js";
import type { CallId, MediaEventId, PayloadRef, SessionId, TraceId } from "./ids.js";
import type { Timestamp } from "./timestamp.js";
import type { TraceEvent } from "./trace.js";

export type CallArtifactAudioFile = "input.pcm" | "output.pcm";

export type CallArtifactTraceFile = "call.jsonl";

export type CallArtifactManifestFile = "manifest.json";

export interface CallArtifactByteRange {
  readonly start: number;
  readonly endExclusive: number;
}

export interface CallArtifactPayload {
  readonly payloadRef: PayloadRef;
  readonly file: CallArtifactAudioFile;
  readonly byteRange: CallArtifactByteRange;
  readonly monotonicOffsetMs: number;
  readonly durationMs: number;
  readonly format: AudioFormat;
  readonly mediaEventId?: MediaEventId;
}

export interface CallArtifactPrivacy {
  readonly consentMode: "record" | "do_not_record";
  readonly persistAudio: boolean;
  readonly redactPii: boolean;
  readonly retentionMs?: number;
}

export interface CallArtifactManifest {
  readonly version: "0.1.0";
  readonly callId: CallId;
  readonly sessionId: SessionId;
  readonly traceId: TraceId;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  readonly files: {
    readonly trace: CallArtifactTraceFile;
    readonly inputAudio?: CallArtifactAudioFile;
    readonly outputAudio?: CallArtifactAudioFile;
    readonly manifest: CallArtifactManifestFile;
  };
  readonly privacy: CallArtifactPrivacy;
  readonly payloads: readonly CallArtifactPayload[];
  /**
   * Number of artifact writes that failed during the call. When > 0 the trace/audio
   * are incomplete — the manifest must not be read as a faithful, complete record.
   */
  readonly writeFailures: number;
}

export interface AudioArtifactChunk {
  readonly payloadRef: PayloadRef;
  readonly mediaEventId?: MediaEventId;
  readonly direction: "input" | "output";
  readonly bytes: Uint8Array;
  readonly monotonicOffsetMs: number;
  readonly durationMs: number;
  readonly format: AudioFormat;
}

/**
 * Persistence boundary for a single call's artifacts. Implementations MUST
 * serialize writes internally (ordered, no interleaving) and `close()` MUST
 * drain all pending writes before finalizing the manifest. Consumers depend on
 * this interface, not a concrete writer.
 */
export interface CallArtifactSink {
  export(events: readonly TraceEvent[]): Promise<void>;
  appendAudio(chunk: AudioArtifactChunk): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}
