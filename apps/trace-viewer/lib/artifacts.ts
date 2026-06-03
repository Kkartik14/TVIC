import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

import {
  deriveCallInspection,
  deriveCallTimeline,
  isTraceEvent,
  type CallInspection,
  type CallTimeline,
} from "@tvic/tracing";
import type { CallArtifactManifest, TraceEvent } from "@tvic/core";

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
  /** True when artifact writes failed during the call — the record is incomplete. */
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

async function readManifest(callId: string): Promise<CallArtifactManifest | null> {
  return readFile(join(callDir(callId), "manifest.json"), "utf8")
    .then((body) => JSON.parse(body) as CallArtifactManifest)
    .catch(() => null);
}

/**
 * Parses call.jsonl into trace events, skipping any line that is not valid JSON or
 * does not pass the full trace-core validator (`isTraceEvent` — requires id, traceId,
 * sessionId, timestamp, spanId, correlationId, type, status, and a finite
 * monotonicOffsetMs). The viewer reads artifacts that may be corrupt or partially
 * written (a crashed/killed writer), so a bad line must never throw or enter the
 * analyzer half-formed; it is dropped and counted instead.
 */
function parseTraceEvents(jsonl: string): {
  readonly events: TraceEvent[];
  readonly dropped: number;
} {
  const events: TraceEvent[] = [];
  let dropped = 0;
  for (const line of jsonl.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      dropped += 1;
      continue;
    }
    if (isTraceEvent(parsed)) {
      events.push(parsed);
    } else {
      dropped += 1;
    }
  }
  return { events, dropped };
}

export async function loadCall(callId: string): Promise<LoadedCall> {
  const jsonl = await readFile(join(callDir(callId), "call.jsonl"), "utf8");
  const { events, dropped } = parseTraceEvents(jsonl);
  return {
    callId,
    events,
    timeline: deriveCallTimeline(events),
    manifest: await readManifest(callId),
    droppedEventCount: dropped,
  };
}

/** A track is available only if its PCM file actually exists with bytes (persistAudio off → none). */
async function trackAvailable(callId: string, file: "input.pcm" | "output.pcm"): Promise<boolean> {
  return stat(join(callDir(callId), file))
    .then((stats) => stats.isFile() && stats.size > 0)
    .catch(() => false);
}

/**
 * Reads a call's artifacts and returns the semantic `CallInspection` the UI renders.
 * This layer only reads bytes/files and reports availability; all interpretation
 * (failures, incidents, latency, replay segments) lives in `@tvic/tracing`. Degraded
 * artifacts are surfaced, never hidden — a missing manifest marks the call degraded.
 */
export async function loadCallInspection(callId: string): Promise<CallInspection> {
  const jsonl = await readFile(join(callDir(callId), "call.jsonl"), "utf8");
  const { events, dropped } = parseTraceEvents(jsonl);
  const manifest = await readManifest(callId);
  const [inputTrackAvailable, outputTrackAvailable] = await Promise.all([
    trackAvailable(callId, "input.pcm"),
    trackAvailable(callId, "output.pcm"),
  ]);
  return deriveCallInspection(events, {
    callId,
    manifest,
    manifestMissing: manifest === null,
    inputTrackAvailable,
    outputTrackAvailable,
    droppedEventCount: dropped,
  });
}

export async function listCalls(): Promise<readonly CallSummary[]> {
  const entries = await readdir(callsDir(), { withFileTypes: true }).catch(() => []);
  const summaries: CallSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SAFE_CALL_ID.test(entry.name)) {
      continue;
    }
    const call = await loadCall(entry.name).catch(() => null);
    if (!call) {
      continue;
    }
    summaries.push({
      callId: entry.name,
      turns: call.timeline.turns.length,
      interruptions: call.timeline.interruptions,
      durationMs: Math.round(call.timeline.endMs - call.timeline.startMs),
      ...(typeof call.manifest?.createdAt === "string"
        ? { createdAt: call.manifest.createdAt }
        : {}),
      // A missing manifest means close() never finished, a write failure means data was
      // lost, and dropped trace lines mean the trace is corrupt — all are degraded.
      degraded:
        call.manifest === null ||
        !(call.manifest.writeFailures >= 0) ||
        call.manifest.writeFailures > 0 ||
        call.droppedEventCount > 0,
    });
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
 */
export async function loadAudioTrack(
  callId: string,
  track: "input" | "output",
): Promise<CallAudio | null> {
  const file = track === "input" ? "input.pcm" : "output.pcm";
  const raw = await readFile(join(callDir(callId), file)).catch(() => null);
  if (!raw) {
    return null;
  }
  const source = new Uint8Array(raw);
  const manifest = await readManifest(callId);
  // The manifest is read from disk untrusted — validate and clamp every payload so a
  // malformed range can neither crash the route nor size an enormous buffer.
  const rawPayloads = Array.isArray(manifest?.payloads) ? manifest.payloads : [];
  const payloads = rawPayloads.filter(
    (p): p is (typeof rawPayloads)[number] =>
      p != null &&
      p.file === file &&
      isFiniteNumber(p.byteRange?.start) &&
      isFiniteNumber(p.byteRange?.endExclusive) &&
      isFiniteNumber(p.monotonicOffsetMs) &&
      p.byteRange.start >= 0 &&
      p.byteRange.endExclusive > p.byteRange.start &&
      p.byteRange.start < source.byteLength,
  );

  const rate = payloads[0]?.format?.sampleRateHz;
  const sampleRateHz = isFiniteNumber(rate) && rate > 0 ? rate : 16000;
  if (payloads.length === 0) {
    return { bytes: source, sampleRateHz }; // no usable mapping — fall back to raw bytes
  }

  // Use the SAME origin the UI seeks against (timeline.startMs), so audio t=0 and
  // `turnStartMs - timeline.startMs` agree on one clock.
  const originMs = await callOriginMs(callId);
  // Cap the reconstructed track so a bad/huge offset can't allocate unbounded memory:
  // the real audio plus a bounded silence budget.
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

// Bounded silence budget for gap-filling a reconstructed track (~10 min @ 16k mono
// s16le). Keeps a corrupt manifest offset from sizing an unbounded buffer.
const MAX_SILENCE_BYTES = 10 * 60 * 16000 * 2;

async function callOriginMs(callId: string): Promise<number> {
  const jsonl = await readFile(join(callDir(callId), "call.jsonl"), "utf8").catch(() => "");
  let origin = Number.POSITIVE_INFINITY;
  for (const event of parseTraceEvents(jsonl).events) {
    origin = Math.min(origin, event.monotonicOffsetMs);
  }
  return Number.isFinite(origin) ? origin : 0;
}
