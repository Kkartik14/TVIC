import type { AudioFormat } from "./audio.js";
import type { CallId, MediaEventId, PayloadRef, SessionId, TraceId } from "./ids.js";
import type { Timestamp } from "./timestamp.js";

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
}
