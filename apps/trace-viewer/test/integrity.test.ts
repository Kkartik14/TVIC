import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { listCalls, loadAudioTrack, loadCall } from "../lib/artifacts";
import { pcm16ToWav } from "../lib/wav";

// 16 kHz mono s16le → 32 bytes per ms.
const RATE = 16000;
const BYTES_PER_MS = (RATE * 2) / 1000;

const sessionCreated = {
  id: "event_1",
  traceId: "trace_1",
  sessionId: "session_1",
  timestamp: "2026-05-20T00:00:00.000Z",
  monotonicOffsetMs: 0,
  spanId: "span_1",
  correlationId: "correlation_1",
  type: "session.created",
  status: "succeeded",
  agentId: "agent_1",
};

interface SyntheticCall {
  readonly events?: readonly unknown[];
  readonly writeFailures?: number;
  readonly omitManifest?: boolean;
  readonly inputPcm?: Uint8Array;
  readonly outputPcm?: Uint8Array;
  readonly payloads?: readonly unknown[];
}

async function writeCall(callId: string, spec: SyntheticCall): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tvic-integrity-"));
  process.env.CALLS_DIR = root;
  const dir = join(root, callId);
  await mkdir(dir, { recursive: true });

  const events = spec.events ?? [sessionCreated];
  await writeFile(dir + "/call.jsonl", events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  if (spec.inputPcm) {
    await writeFile(join(dir, "input.pcm"), spec.inputPcm);
  }
  if (spec.outputPcm) {
    await writeFile(join(dir, "output.pcm"), spec.outputPcm);
  }
  if (!spec.omitManifest) {
    const manifest = {
      version: "0.1.0",
      callId,
      sessionId: "session_1",
      traceId: "trace_1",
      createdAt: "2026-05-20T00:00:00.000Z",
      updatedAt: "2026-05-20T00:00:01.000Z",
      files: {
        trace: "call.jsonl",
        manifest: "manifest.json",
        ...(spec.inputPcm ? { inputAudio: "input.pcm" } : {}),
        ...(spec.outputPcm ? { outputAudio: "output.pcm" } : {}),
      },
      privacy: { consentMode: "record", persistAudio: true, redactPii: false },
      payloads: spec.payloads ?? [],
      writeFailures: spec.writeFailures ?? 0,
    };
    await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest));
  }
  return root;
}

describe("artifact integrity", () => {
  const previous = process.env.CALLS_DIR;
  afterEach(() => {
    if (previous === undefined) {
      delete process.env.CALLS_DIR;
    } else {
      process.env.CALLS_DIR = previous;
    }
  });

  it("loads a complete call: events, manifest, not degraded", async () => {
    await writeCall("call_ok", { writeFailures: 0 });
    const call = await loadCall("call_ok");
    expect(call.events).toHaveLength(1);
    expect(call.manifest?.writeFailures).toBe(0);

    const summary = (await listCalls()).find((c) => c.callId === "call_ok");
    expect(summary?.degraded).toBe(false);
  });

  it("reconstructs a call-clock-aligned audio track from manifest byte ranges", async () => {
    // One 1 ms chunk captured at 110 ms; call origin (min trace offset) is 100 ms.
    const chunk = new Uint8Array(Array.from({ length: BYTES_PER_MS }, (_, i) => (i % 255) + 1));
    await writeCall("call_audio", {
      events: [{ ...sessionCreated, monotonicOffsetMs: 100 }],
      inputPcm: chunk,
      payloads: [
        {
          payloadRef: "p1",
          file: "input.pcm",
          byteRange: { start: 0, endExclusive: chunk.byteLength },
          monotonicOffsetMs: 110,
          durationMs: 1,
          format: { encoding: "pcm_s16le", sampleRateHz: RATE, channels: 1 },
        },
      ],
    });

    const audio = await loadAudioTrack("call_audio", "input");
    expect(audio?.sampleRateHz).toBe(RATE);
    const offset = (110 - 100) * BYTES_PER_MS; // placed after a 10 ms silence gap
    expect(audio?.bytes.byteLength).toBe(offset + chunk.byteLength);
    expect(Array.from(audio!.bytes.subarray(0, offset))).toEqual(new Array(offset).fill(0));
    expect(Array.from(audio!.bytes.subarray(offset))).toEqual(Array.from(chunk));
  });

  it("marks a call degraded when a write failed", async () => {
    await writeCall("call_failed", { writeFailures: 3 });
    const summary = (await listCalls()).find((c) => c.callId === "call_failed");
    expect(summary?.degraded).toBe(true);
  });

  it("marks a call degraded when the manifest is missing", async () => {
    await writeCall("call_no_manifest", { omitManifest: true });
    const call = await loadCall("call_no_manifest");
    expect(call.manifest).toBeNull();
    const summary = (await listCalls()).find((c) => c.callId === "call_no_manifest");
    expect(summary?.degraded).toBe(true);
  });

  it("wraps PCM in a WAV header with the correct duration metadata", () => {
    const pcm = new Uint8Array(RATE * 2); // exactly 1 second of 16 kHz mono s16le
    const wav = pcm16ToWav(pcm, RATE);
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(wav.readUInt32LE(24)).toBe(RATE); // sample rate
    expect(wav.readUInt32LE(40)).toBe(pcm.byteLength); // data size
    const durationSec = wav.readUInt32LE(40) / wav.readUInt32LE(28); // dataSize / byteRate
    expect(durationSec).toBe(1);
  });
});
