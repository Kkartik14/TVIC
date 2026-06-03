import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { listCalls, loadAudioTrack, loadCallInspection } from "../lib/artifacts";
import { pcm16ToWav } from "../lib/wav";

const TURN = "turn_1";
const SESSION = "session_1";

function ev(
  spanId: string,
  offsetMs: number,
  fields: Record<string, unknown>,
  turnId?: string,
  parentSpanId?: string,
) {
  return {
    id: `evt_${spanId}_${offsetMs}`,
    traceId: "trace_1",
    sessionId: SESSION,
    timestamp: "2026-05-20T00:00:00.000Z",
    monotonicOffsetMs: offsetMs,
    spanId,
    correlationId: "corr_1",
    ...(turnId ? { turnId } : {}),
    ...(parentSpanId ? { parentSpanId } : {}),
    ...fields,
  };
}

const HAPPY_TURN = [
  ev("s_sess", 0, { type: "session.created", status: "succeeded", agentId: "agent_1" }),
  ev("s_sess", 0, { type: "session.started", status: "succeeded" }),
  ev("s_turn", 0, { type: "turn.started", status: "started", sequence: 1 }, TURN, "s_sess"),
  ev(
    "s_stt",
    100,
    { type: "stt.final", status: "succeeded", text: "book a table", durationMs: 0 },
    TURN,
    "s_ctrl",
  ),
  ev("s_llm", 110, { type: "llm.started", status: "started", model: "m" }, TURN, "s_ctrl"),
  ev("s_llm", 170, { type: "llm.token", status: "in_progress", text: "Done" }, TURN, "s_ctrl"),
  ev(
    "s_llm",
    200,
    { type: "llm.completed", status: "succeeded", model: "m", durationMs: 90 },
    TURN,
    "s_ctrl",
  ),
  ev(
    "s_audio",
    255,
    {
      type: "audio.output.chunk",
      status: "in_progress",
      mediaEventId: "me_1",
      frameCount: 320,
      durationMs: 20,
    },
    TURN,
    "s_ctrl",
  ),
  ev(
    "s_audio",
    360,
    { type: "audio.output.ended", status: "succeeded", durationMs: 100 },
    TURN,
    "s_ctrl",
  ),
  ev("s_turn", 400, { type: "turn.ended", status: "succeeded", durationMs: 400 }, TURN, "s_sess"),
  ev("s_sess", 410, { type: "session.completed", status: "succeeded", durationMs: 410 }),
];

interface Spec {
  readonly events?: readonly unknown[];
  readonly omitManifest?: boolean;
  readonly writeFailures?: number;
  readonly withInputAudio?: boolean;
}

async function writeCall(callId: string, spec: Spec): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "tvic-inspection-"));
  process.env.CALLS_DIR = root;
  const dir = join(root, callId);
  await mkdir(dir, { recursive: true });
  const events = spec.events ?? HAPPY_TURN;
  await writeFile(join(dir, "call.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  if (spec.withInputAudio) {
    await writeFile(join(dir, "input.pcm"), new Uint8Array(640));
  }
  if (!spec.omitManifest) {
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify({
        version: "0.1.0",
        callId,
        sessionId: SESSION,
        traceId: "trace_1",
        createdAt: "2026-05-20T00:00:00.000Z",
        updatedAt: "2026-05-20T00:00:01.000Z",
        files: {
          trace: "call.jsonl",
          manifest: "manifest.json",
          ...(spec.withInputAudio ? { inputAudio: "input.pcm" } : {}),
        },
        privacy: { consentMode: "record", persistAudio: true, redactPii: false },
        payloads: [],
        writeFailures: spec.writeFailures ?? 0,
      }),
    );
  }
}

describe("loadCallInspection", () => {
  const previous = process.env.CALLS_DIR;
  afterEach(() => {
    if (previous === undefined) {
      delete process.env.CALLS_DIR;
    } else {
      process.env.CALLS_DIR = previous;
    }
  });

  it("returns a CallInspection for a complete call with audio availability", async () => {
    await writeCall("call_ok", { withInputAudio: true });
    const call = await loadCallInspection("call_ok");

    expect(call.callId).toBe("call_ok");
    expect(call.status).toBe("completed");
    expect(call.turns).toHaveLength(1);
    expect(call.turns[0]!.status).toBe("completed");
    expect(call.turns[0]!.callerText).toBe("book a table");
    expect(call.degraded).toBe(false);
    expect(call.recording.consentMode).toBe("record");
    expect(call.recording.inputTrackAvailable).toBe(true);
    expect(call.recording.outputTrackAvailable).toBe(false); // no output.pcm written
    expect(call.rawEventCount).toBe(HAPPY_TURN.length);
  });

  it("marks the call degraded when the manifest is missing", async () => {
    await writeCall("call_no_manifest", { omitManifest: true });
    const call = await loadCallInspection("call_no_manifest");
    expect(call.degraded).toBe(true);
    expect(call.artifactWarnings.some((w) => w.toLowerCase().includes("manifest"))).toBe(true);
  });

  it("marks the call degraded when a write failed, and still returns turns", async () => {
    await writeCall("call_failed", { writeFailures: 2 });
    const call = await loadCallInspection("call_failed");
    expect(call.degraded).toBe(true);
    expect(call.turns).toHaveLength(1);
  });

  it("drops trace lines missing core ids and marks the call degraded", async () => {
    // Valid JSON, but missing id/spanId/traceId/etc — must not enter the analyzer.
    await writeCall("call_missingids", {
      events: [...HAPPY_TURN, { type: "turn.started", monotonicOffsetMs: 5 }],
    });
    const call = await loadCallInspection("call_missingids");
    expect(call.degraded).toBe(true);
    expect(call.artifactWarnings.some((w) => w.toLowerCase().includes("corrupt"))).toBe(true);
    expect(call.turns).toHaveLength(1); // the well-formed turn still derived
    expect(call.rawEventCount).toBe(HAPPY_TURN.length); // the malformed line is not counted
  });

  it("excludes a dangerous payload sample rate and serves WAV with a safe rate", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvic-badrate-"));
    process.env.CALLS_DIR = root;
    const dir = join(root, "call_badrate");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "call.jsonl"), JSON.stringify(HAPPY_TURN[0]) + "\n");
    await writeFile(join(dir, "input.pcm"), new Uint8Array(640));
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify({
        version: "0.1.0",
        callId: "call_badrate",
        sessionId: SESSION,
        traceId: "trace_1",
        createdAt: "2026-05-20T00:00:00.000Z",
        updatedAt: "2026-05-20T00:00:01.000Z",
        files: { trace: "call.jsonl", inputAudio: "input.pcm", manifest: "manifest.json" },
        privacy: { consentMode: "record", persistAudio: true, redactPii: false },
        payloads: [
          {
            payloadRef: "p1",
            file: "input.pcm",
            byteRange: { start: 0, endExclusive: 640 },
            monotonicOffsetMs: 0,
            durationMs: 20,
            format: { encoding: "pcm_s16le", sampleRateHz: 1e20, channels: 1 }, // dangerous
          },
        ],
      }),
    );

    const audio = await loadAudioTrack("call_badrate", "input");
    expect(audio).not.toBeNull();
    // The dangerous payload is excluded; a safe default rate is used instead.
    expect(audio!.sampleRateHz).toBe(16000);
    // And the WAV writer does not throw on the served rate (route never 500s).
    const wav = pcm16ToWav(audio!.bytes, audio!.sampleRateHz, 1);
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    // The defensive WAV writer itself rejects a dangerous rate outright.
    expect(() => pcm16ToWav(audio!.bytes, 1e20, 1)).toThrow();
  });

  it("does not crash or over-allocate when manifest payloads are malformed", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvic-badmanifest-"));
    process.env.CALLS_DIR = root;
    const dir = join(root, "call_badmanifest");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "call.jsonl"), JSON.stringify(HAPPY_TURN[0]) + "\n");
    await writeFile(join(dir, "input.pcm"), new Uint8Array(640));
    const fmt = { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1 };
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify({
        version: "0.1.0",
        callId: "call_badmanifest",
        sessionId: SESSION,
        traceId: "trace_1",
        createdAt: "2026-05-20T00:00:00.000Z",
        updatedAt: "2026-05-20T00:00:01.000Z",
        files: { trace: "call.jsonl", inputAudio: "input.pcm", manifest: "manifest.json" },
        privacy: { consentMode: "record", persistAudio: true, redactPii: false },
        payloads: [
          // negative start → rejected
          {
            payloadRef: "p1",
            file: "input.pcm",
            byteRange: { start: -5, endExclusive: 10 },
            monotonicOffsetMs: 0,
            durationMs: 1,
            format: fmt,
          },
          // absurd range/offset → range clamped to file, placement capped (not OOM)
          {
            payloadRef: "p2",
            file: "input.pcm",
            byteRange: { start: 0, endExclusive: 1e12 },
            monotonicOffsetMs: 1e15,
            durationMs: 1,
            format: fmt,
          },
        ],
        writeFailures: 0,
      }),
    );

    const audio = await loadAudioTrack("call_badmanifest", "input");
    expect(audio).not.toBeNull();
    // Bounded: never larger than the source PCM plus the silence cap.
    expect(audio!.bytes.byteLength).toBeLessThanOrEqual(640 + 10 * 60 * 16000 * 2);
  });

  it("does not crash on a corrupt JSONL line — bad lines are skipped", async () => {
    // A partially-written / corrupted call.jsonl: one valid event, one garbage line.
    const root = await mkdtemp(join(tmpdir(), "tvic-corrupt-"));
    process.env.CALLS_DIR = root;
    const dir = join(root, "call_corrupt");
    await mkdir(dir, { recursive: true });
    const goodLines = HAPPY_TURN.map((e) => JSON.stringify(e));
    goodLines.splice(3, 0, "{ this is not valid json ]"); // inject a broken line
    await writeFile(join(dir, "call.jsonl"), goodLines.join("\n") + "\n");

    const call = await loadCallInspection("call_corrupt");
    // The broken line is dropped; the valid turn is still derived.
    expect(call.turns).toHaveLength(1);
    expect(call.turns[0]!.status).toBe("completed");
    expect(call.rawEventCount).toBe(HAPPY_TURN.length); // only valid events counted
  });

  it("marks a corrupt-trace call degraded in the call LIST, not just the detail page", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvic-corrupt-list-"));
    process.env.CALLS_DIR = root;
    const dir = join(root, "call_corrupt_list");
    await mkdir(dir, { recursive: true });
    const lines = HAPPY_TURN.map((e) => JSON.stringify(e));
    lines.splice(3, 0, "{ broken json ]"); // corrupt line
    await writeFile(join(dir, "call.jsonl"), lines.join("\n") + "\n");
    // A valid manifest with no write failures — so "degraded" can only come from the
    // dropped trace line, proving the list now reflects trace corruption too.
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify({
        version: "0.1.0",
        callId: "call_corrupt_list",
        sessionId: SESSION,
        traceId: "trace_1",
        createdAt: "2026-05-20T00:00:00.000Z",
        updatedAt: "2026-05-20T00:00:01.000Z",
        files: { trace: "call.jsonl", manifest: "manifest.json" },
        privacy: { consentMode: "record", persistAudio: true, redactPii: false },
        payloads: [],
        writeFailures: 0,
      }),
    );

    const summary = (await listCalls()).find((c) => c.callId === "call_corrupt_list");
    expect(summary?.degraded).toBe(true);
  });
});
