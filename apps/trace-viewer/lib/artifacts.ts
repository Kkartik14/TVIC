import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

import { deriveCallTimeline, type CallTimeline } from "@tvic/tracing";
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
}

async function readManifest(callId: string): Promise<CallArtifactManifest | null> {
  return readFile(join(callDir(callId), "manifest.json"), "utf8")
    .then((body) => JSON.parse(body) as CallArtifactManifest)
    .catch(() => null);
}

export async function loadCall(callId: string): Promise<LoadedCall> {
  const jsonl = await readFile(join(callDir(callId), "call.jsonl"), "utf8");
  const events = jsonl
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as TraceEvent);
  return {
    callId,
    events,
    timeline: deriveCallTimeline(events),
    manifest: await readManifest(callId),
  };
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
      ...(call.manifest?.createdAt ? { createdAt: call.manifest.createdAt } : {}),
      // A missing manifest means close() never finished (incomplete record), and a
      // recorded write failure means data was lost — both are degraded.
      degraded: call.manifest === null || call.manifest.writeFailures > 0,
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
  const payloads = (manifest?.payloads ?? []).filter((p) => p.file === file);

  const sampleRateHz = payloads[0]?.format.sampleRateHz ?? 16000;
  if (payloads.length === 0) {
    return { bytes: source, sampleRateHz }; // no mapping — fall back to raw bytes
  }

  // Use the SAME origin the UI seeks against (timeline.startMs), so audio t=0 and
  // `turnStartMs - timeline.startMs` agree on one clock.
  const originMs = await callOriginMs(callId);
  const bytes = alignPcmToCallClock(
    source,
    payloads.map((p) => ({
      byteStart: p.byteRange.start,
      byteEnd: p.byteRange.endExclusive,
      monotonicOffsetMs: p.monotonicOffsetMs,
    })),
    sampleRateHz,
    originMs,
  );
  return { bytes, sampleRateHz };
}

async function callOriginMs(callId: string): Promise<number> {
  const jsonl = await readFile(join(callDir(callId), "call.jsonl"), "utf8").catch(() => "");
  let origin = Number.POSITIVE_INFINITY;
  for (const line of jsonl.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    const event = JSON.parse(line) as { monotonicOffsetMs?: number };
    if (typeof event.monotonicOffsetMs === "number") {
      origin = Math.min(origin, event.monotonicOffsetMs);
    }
  }
  return Number.isFinite(origin) ? origin : 0;
}
