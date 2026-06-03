import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

import {
  deriveCallInspection,
  deriveCallTimeline,
  parseTraceJsonl,
  type CallInspection,
  type CallTimeline,
} from "@tvic/tracing";
import {
  isReconstructableAudioFormat,
  parseCallArtifactManifest,
  type CallArtifactManifest,
  type TraceEvent,
} from "@tvic/core";

import { alignPcmToCallClock } from "./align";

export function callsDir(): string {
  const configured = process.env.CALLS_DIR;
  if (configured) {
    return isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
  }
  // Default to the live-call gateway's artifact directory.
  return resolve(process.cwd(), "..", "..", "examples", "live-call", "calls");
}

const SAFE_CALL_ID = /^[A-Za-z0-9._-]+$/;
// Bound on concurrent per-call reads when listing, so a directory of thousands of calls
// can't exhaust file descriptors.
const LIST_CONCURRENCY = 16;
// Bounded silence budget for gap-filling a reconstructed track (~10 min @ 16k mono
// s16le). Keeps a corrupt manifest offset from sizing an unbounded buffer.
const MAX_SILENCE_BYTES = 10 * 60 * 16000 * 2;

function callDir(callId: string): string {
  // Resolve-and-assert-within-root: reject "."/".." and anything that escapes the
  // calls directory, even if it passes the character allowlist.
  if (!SAFE_CALL_ID.test(callId) || callId === "." || callId === "..") {
    throw new Error(`Unsafe call id: ${callId}`);
  }
  const root = resolve(callsDir());
  const target = resolve(root, callId);
  if (target !== root && target.startsWith(`${root}${sep}`)) {
    return target;
  }
  throw new Error(`Call id escapes root: ${callId}`);
}

export interface CallSummary {
  readonly callId: string;
  readonly turns: number;
  readonly interruptions: number;
  readonly durationMs: number;
  readonly createdAt?: string;
  /** True when the artifact record is incomplete/corrupt in any way. */
  readonly degraded: boolean;
}

export interface LoadedCall {
  readonly callId: string;
  readonly events: readonly TraceEvent[];
  readonly timeline: CallTimeline;
  readonly manifest: CallArtifactManifest | null;
  /** Trace lines dropped as corrupt — a positive count means the record is incomplete. */
  readonly droppedEventCount: number;
}

type ManifestResult =
  | { readonly status: "valid"; readonly manifest: CallArtifactManifest }
  | { readonly status: "missing" }
  | { readonly status: "invalid"; readonly reason: string };

/** Reads manifest.json as untrusted disk data: parsed-and-validated, never cast. */
async function readManifest(callId: string): Promise<ManifestResult> {
  const body = await readFile(join(callDir(callId), "manifest.json"), "utf8").catch(() => null);
  if (body === null) {
    return { status: "missing" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { status: "invalid", reason: "manifest is not valid JSON" };
  }
  const result = parseCallArtifactManifest(parsed);
  return result.ok
    ? { status: "valid", manifest: result.manifest }
    : { status: "invalid", reason: result.reason };
}

/** A track is available only if its PCM file actually exists with bytes (persistAudio off → none). */
async function trackAvailable(callId: string, file: "input.pcm" | "output.pcm"): Promise<boolean> {
  return stat(join(callDir(callId), file))
    .then((stats) => stats.isFile() && stats.size > 0)
    .catch(() => false);
}

export async function loadCall(callId: string): Promise<LoadedCall> {
  const [jsonl, manifestResult] = await Promise.all([
    readFile(join(callDir(callId), "call.jsonl"), "utf8"),
    readManifest(callId),
  ]);
  const { events, dropped } = parseTraceJsonl(jsonl);
  return {
    callId,
    events,
    timeline: deriveCallTimeline(events),
    manifest: manifestResult.status === "valid" ? manifestResult.manifest : null,
    droppedEventCount: dropped,
  };
}

/**
 * Reads a call's artifacts and returns the semantic `CallInspection` the UI renders.
 * This layer only reads bytes/files and reports availability; all interpretation
 * (failures, incidents, latency, replay segments) lives in `@tvic/tracing`. Degraded
 * artifacts are surfaced, never hidden — a missing/invalid manifest, dropped trace
 * lines, or incomplete identity all mark the call degraded.
 */
export async function loadCallInspection(callId: string): Promise<CallInspection> {
  const [jsonl, manifestResult, inputTrackAvailable, outputTrackAvailable] = await Promise.all([
    readFile(join(callDir(callId), "call.jsonl"), "utf8"),
    readManifest(callId),
    trackAvailable(callId, "input.pcm"),
    trackAvailable(callId, "output.pcm"),
  ]);
  const { events, dropped } = parseTraceJsonl(jsonl);
  const manifest = manifestResult.status === "valid" ? manifestResult.manifest : null;
  return deriveCallInspection(events, {
    callId,
    manifest,
    manifestMissing: manifestResult.status !== "valid",
    inputTrackAvailable,
    outputTrackAvailable,
    droppedEventCount: dropped,
    ...(manifestResult.status === "invalid"
      ? { artifactWarnings: [`Manifest invalid: ${manifestResult.reason}`] }
      : {}),
  });
}

function summarize(callId: string, call: LoadedCall): CallSummary {
  const manifest = call.manifest;
  return {
    callId,
    turns: call.timeline.turns.length,
    interruptions: call.timeline.interruptions,
    durationMs: Math.round(call.timeline.endMs - call.timeline.startMs),
    ...(typeof manifest?.createdAt === "string" ? { createdAt: manifest.createdAt } : {}),
    // Missing/invalid manifest (manifest === null), a recorded write failure, dropped
    // trace lines, or incomplete identity all make the call degraded.
    degraded:
      manifest === null ||
      !(manifest.writeFailures >= 0) ||
      manifest.writeFailures > 0 ||
      manifest.integrity === "incomplete" ||
      call.droppedEventCount > 0,
  };
}

export async function listCalls(): Promise<readonly CallSummary[]> {
  const entries = await readdir(callsDir(), { withFileTypes: true }).catch(() => []);
  const names = entries
    .filter((entry) => entry.isDirectory() && SAFE_CALL_ID.test(entry.name))
    .map((entry) => entry.name);

  const summaries: CallSummary[] = [];
  // Bounded concurrency: load calls in parallel batches so a large directory is fast
  // without exhausting file descriptors. A failed load drops that call, not the list.
  for (let i = 0; i < names.length; i += LIST_CONCURRENCY) {
    const batch = names.slice(i, i + LIST_CONCURRENCY);
    const loaded = await Promise.all(
      batch.map((name) =>
        loadCall(name)
          .then((call) => summarize(name, call))
          .catch(() => null),
      ),
    );
    for (const summary of loaded) {
      if (summary) {
        summaries.push(summary);
      }
    }
  }
  return summaries.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

export interface CallAudio {
  readonly bytes: Uint8Array;
  readonly sampleRateHz: number;
}

/**
 * Reconstructs a **call-clock-aligned** PCM track: each persisted chunk is placed
 * at its `monotonicOffsetMs`, with gaps filled by silence, so the track's t=0 is
 * the call start. This makes "play from here" (which seeks by call-clock offset)
 * land on the right audio instead of drifting on a gapless concatenation.
 *
 * Every payload (range AND audio format) is validated because the manifest is
 * untrusted disk data — a bad sample rate must never reach the WAV writer's
 * `writeUInt32LE` (which throws on a non-integer / out-of-range value).
 */
export async function loadAudioTrack(
  callId: string,
  track: "input" | "output",
): Promise<CallAudio | null> {
  const file = track === "input" ? "input.pcm" : "output.pcm";
  const [raw, manifestResult] = await Promise.all([
    readFile(join(callDir(callId), file)).catch(() => null),
    readManifest(callId),
  ]);
  if (!raw) {
    return null;
  }
  const source = new Uint8Array(raw);
  const manifest = manifestResult.status === "valid" ? manifestResult.manifest : null;
  const rawPayloads = Array.isArray(manifest?.payloads) ? manifest.payloads : [];
  const payloads = rawPayloads.filter(
    (p): p is (typeof rawPayloads)[number] =>
      p != null &&
      p.file === file &&
      isReconstructableAudioFormat(p.format) &&
      isFiniteNumber(p.byteRange?.start) &&
      isFiniteNumber(p.byteRange?.endExclusive) &&
      isFiniteNumber(p.monotonicOffsetMs) &&
      p.byteRange.start >= 0 &&
      p.byteRange.endExclusive > p.byteRange.start &&
      p.byteRange.start < source.byteLength,
  );

  // Every surviving payload has a reconstructable (safe-integer) sample rate.
  const sampleRateHz = payloads[0]?.format.sampleRateHz ?? 16000;
  if (payloads.length === 0) {
    return { bytes: source, sampleRateHz }; // no usable mapping — fall back to raw bytes
  }

  // Use the SAME origin the UI seeks against (timeline.startMs), so audio t=0 and
  // `turnStartMs - timeline.startMs` agree on one clock.
  const originMs = await callOriginMs(callId);
  const maxBytes = source.byteLength + MAX_SILENCE_BYTES;
  const bytes = alignPcmToCallClock(
    source,
    payloads.map((p) => ({
      byteStart: p.byteRange.start,
      byteEnd: Math.min(p.byteRange.endExclusive, source.byteLength), // clamp to the file
      monotonicOffsetMs: p.monotonicOffsetMs,
    })),
    sampleRateHz,
    originMs,
    maxBytes,
  );
  return { bytes, sampleRateHz };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

async function callOriginMs(callId: string): Promise<number> {
  const jsonl = await readFile(join(callDir(callId), "call.jsonl"), "utf8").catch(() => "");
  let origin = Number.POSITIVE_INFINITY;
  for (const event of parseTraceJsonl(jsonl).events) {
    origin = Math.min(origin, event.monotonicOffsetMs);
  }
  return Number.isFinite(origin) ? origin : 0;
}
