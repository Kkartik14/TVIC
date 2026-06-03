import { isReconstructableAudioFormat, type AudioFormat } from "./audio.js";
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
  /** Absent when the writer could never determine identity (no trace event exported). */
  readonly sessionId?: SessionId;
  readonly traceId?: TraceId;
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
  /**
   * `incomplete` when identity (sessionId/traceId) could not be determined at close —
   * an honest signal instead of writing sentinel IDs. Absent on legacy manifests is
   * normalized from identity: complete when both ids exist, incomplete otherwise.
   */
  readonly integrity?: "complete" | "incomplete";
}

export type CallArtifactManifestParse =
  | { readonly ok: true; readonly manifest: CallArtifactManifest }
  | { readonly ok: false; readonly reason: string };

/**
 * Validates an untrusted (disk-read) value as a `CallArtifactManifest`. The manifest is
 * a contract but disk data is not, so every reader (viewer, DAL prune) must parse — not
 * cast — to avoid trusting corrupt values. Validates the envelope and every payload
 * mapping. Returns the reason on failure so callers can warn.
 */
const MANIFEST_VERSION = "0.1.0";

function isAudioFile(value: unknown): value is CallArtifactAudioFile {
  return value === "input.pcm" || value === "output.pcm";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is Timestamp {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

type PayloadParse =
  | { readonly ok: true; readonly payload: CallArtifactPayload }
  | { readonly ok: false; readonly reason: string };

function parsePayload(value: unknown): PayloadParse {
  if (!isRecord(value)) {
    return { ok: false, reason: "payload is not an object" };
  }
  if (!isNonEmptyString(value.payloadRef)) {
    return { ok: false, reason: "payload missing payloadRef" };
  }
  if (!isAudioFile(value.file)) {
    return { ok: false, reason: "payload has invalid file" };
  }
  if (!isRecord(value.byteRange)) {
    return { ok: false, reason: "payload missing byteRange" };
  }
  const { start, endExclusive } = value.byteRange;
  if (!isSafeNonNegativeInteger(start) || !isSafeNonNegativeInteger(endExclusive)) {
    return { ok: false, reason: "payload byteRange must be safe non-negative integers" };
  }
  if (endExclusive <= start) {
    return { ok: false, reason: "payload byteRange is empty" };
  }
  if (!isNonNegativeFiniteNumber(value.monotonicOffsetMs)) {
    return { ok: false, reason: "payload monotonicOffsetMs is invalid" };
  }
  if (!isNonNegativeFiniteNumber(value.durationMs)) {
    return { ok: false, reason: "payload durationMs is invalid" };
  }
  if (!isReconstructableAudioFormat(value.format)) {
    return { ok: false, reason: "payload format is not reconstructable" };
  }
  if (value.mediaEventId !== undefined && !isNonEmptyString(value.mediaEventId)) {
    return { ok: false, reason: "payload mediaEventId is invalid" };
  }
  return {
    ok: true,
    payload: {
      payloadRef: value.payloadRef as PayloadRef,
      file: value.file,
      byteRange: { start, endExclusive },
      monotonicOffsetMs: value.monotonicOffsetMs,
      durationMs: value.durationMs,
      format: value.format,
      ...(value.mediaEventId !== undefined
        ? { mediaEventId: value.mediaEventId as MediaEventId }
        : {}),
    },
  };
}

export function parseCallArtifactManifest(value: unknown): CallArtifactManifestParse {
  if (!isRecord(value)) {
    return { ok: false, reason: "manifest is not an object" };
  }
  const m = value;
  if (!isNonEmptyString(m.callId)) {
    return { ok: false, reason: "missing callId" };
  }
  if (m.version !== MANIFEST_VERSION) {
    return { ok: false, reason: `unsupported version (expected ${MANIFEST_VERSION})` };
  }
  if (!isTimestamp(m.createdAt) || !isTimestamp(m.updatedAt)) {
    return { ok: false, reason: "missing timestamps" };
  }
  const privacy = m.privacy;
  if (!isRecord(privacy)) {
    return { ok: false, reason: "missing privacy block" };
  }
  if (privacy.consentMode !== "record" && privacy.consentMode !== "do_not_record") {
    return { ok: false, reason: "invalid privacy.consentMode" };
  }
  if (typeof privacy.persistAudio !== "boolean" || typeof privacy.redactPii !== "boolean") {
    return { ok: false, reason: "invalid privacy flags" };
  }
  if (privacy.retentionMs !== undefined && !isSafeNonNegativeInteger(privacy.retentionMs)) {
    return { ok: false, reason: "invalid privacy.retentionMs" };
  }
  const parsedPrivacy: CallArtifactPrivacy = {
    consentMode: privacy.consentMode,
    persistAudio: privacy.persistAudio,
    redactPii: privacy.redactPii,
    ...(privacy.retentionMs !== undefined ? { retentionMs: privacy.retentionMs } : {}),
  };

  if (!isSafeNonNegativeInteger(m.writeFailures)) {
    return { ok: false, reason: "invalid writeFailures" };
  }

  if (!Array.isArray(m.payloads)) {
    return { ok: false, reason: "invalid payloads" };
  }
  const payloads: CallArtifactPayload[] = [];
  for (const payloadValue of m.payloads) {
    const parsed = parsePayload(payloadValue);
    if (!parsed.ok) {
      return { ok: false, reason: parsed.reason };
    }
    payloads.push(parsed.payload);
  }

  // files: exact known filenames; trace + manifest required, audio files optional.
  const files = m.files;
  if (!isRecord(files)) {
    return { ok: false, reason: "missing files block" };
  }
  if (files.trace !== "call.jsonl" || files.manifest !== "manifest.json") {
    return { ok: false, reason: "invalid files block" };
  }
  if (files.inputAudio !== undefined && files.inputAudio !== "input.pcm") {
    return { ok: false, reason: "invalid files.inputAudio" };
  }
  if (files.outputAudio !== undefined && files.outputAudio !== "output.pcm") {
    return { ok: false, reason: "invalid files.outputAudio" };
  }

  // Identity + integrity, with consistency: a "complete" manifest must carry both ids.
  if (m.sessionId !== undefined && !isNonEmptyString(m.sessionId)) {
    return { ok: false, reason: "invalid sessionId" };
  }
  if (m.traceId !== undefined && !isNonEmptyString(m.traceId)) {
    return { ok: false, reason: "invalid traceId" };
  }
  if (m.integrity !== undefined && m.integrity !== "complete" && m.integrity !== "incomplete") {
    return { ok: false, reason: "invalid integrity" };
  }
  const hasIdentity = isNonEmptyString(m.sessionId) && isNonEmptyString(m.traceId);
  const integrity = m.integrity ?? (hasIdentity ? "complete" : "incomplete");
  if (integrity === "complete" && !hasIdentity) {
    return { ok: false, reason: "integrity 'complete' but identity is missing" };
  }

  return {
    ok: true,
    manifest: {
      version: MANIFEST_VERSION,
      callId: m.callId as CallId,
      ...(hasIdentity
        ? { sessionId: m.sessionId as SessionId, traceId: m.traceId as TraceId }
        : {}),
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      files: {
        trace: "call.jsonl",
        ...(files.inputAudio !== undefined ? { inputAudio: "input.pcm" } : {}),
        ...(files.outputAudio !== undefined ? { outputAudio: "output.pcm" } : {}),
        manifest: "manifest.json",
      },
      privacy: parsedPrivacy,
      payloads,
      writeFailures: m.writeFailures,
      integrity,
    },
  };
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
