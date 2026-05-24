import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LocalCallArtifactWriter } from "@tvic/dal";
import {
  nowTimestamp,
  type CallId,
  type TraceEvent,
  type TraceExporter,
  type TraceStore,
} from "@tvic/core";

import { createRuntime } from "../src/index.js";
import { buildAgent } from "./harness.js";

const PRIVACY = { consentMode: "record", persistAudio: false, redactPii: false } as const;

function hangingStore(): TraceStore {
  return {
    append: () => new Promise<void>(() => undefined), // never resolves
    async query() {
      return [];
    },
    async close() {
      return;
    },
  };
}

function hangingExporter(name: string): TraceExporter {
  return {
    name,
    kind: "trace_exporter",
    version: "0.1.0",
    capabilities: { streaming: false, interruption: false },
    export: () => new Promise<void>(() => undefined), // never resolves
    async flush() {
      return;
    },
    async close() {
      return;
    },
  };
}

async function readTrace(root: string, callId: string): Promise<string> {
  return readFile(join(root, callId, "call.jsonl"), "utf8");
}

async function makeWriterCall(root: string, callId: string): Promise<LocalCallArtifactWriter> {
  return new LocalCallArtifactWriter({
    rootDir: root,
    callId: callId as CallId,
    createdAt: nowTimestamp(),
    privacy: PRIVACY,
  });
}

describe("observability integration: sink isolation under failure", () => {
  it("delivers session.completed to the per-call writer even when the trace store hangs", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvic-obs-"));
    const runtime = createRuntime({
      traceStore: hangingStore(),
      traceFlushTimeoutMs: 80,
    });
    await runtime.start();
    const writer = await makeWriterCall(root, "call_store_hang");
    const session = await runtime.startSession(buildAgent(), {
      channel: "simulated",
      traceExporters: [writer],
    });

    await runtime.endSession(session.id, { reason: "completed" });
    await writer.close();

    const jsonl = await readTrace(root, "call_store_hang");
    expect(jsonl).toContain("session.created");
    expect(jsonl).toContain("session.completed");
  });

  it("delivers the terminal trace to the per-call writer even when a global exporter hangs", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvic-obs-"));
    const runtime = createRuntime({
      traceExporters: [hangingExporter("global-hang")],
      traceFlushTimeoutMs: 80,
    });
    await runtime.start();
    const writer = await makeWriterCall(root, "call_exporter_hang");
    const session = await runtime.startSession(buildAgent(), {
      channel: "simulated",
      traceExporters: [writer],
    });

    await runtime.endSession(session.id, { reason: "completed" });
    await writer.close();

    expect(await readTrace(root, "call_exporter_hang")).toContain("session.completed");
  });

  it("keeps the writer's trace ordered and immutable after close (no late mutation)", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvic-obs-"));
    const runtime = createRuntime({
      traceStore: hangingStore(),
      traceFlushTimeoutMs: 80,
    });
    await runtime.start();
    const writer = await makeWriterCall(root, "call_order");
    const session = await runtime.startSession(buildAgent(), {
      channel: "simulated",
      traceExporters: [writer],
    });
    await runtime.endSession(session.id, { reason: "completed" });
    await writer.close();

    const lines = (await readTrace(root, "call_order"))
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as TraceEvent);
    // Ordered (monotonic, by emission) and the expected lifecycle, in order.
    expect(lines.map((e) => e.type)).toEqual([
      "session.created",
      "session.started",
      "session.completed",
    ]);
    for (let i = 1; i < lines.length; i += 1) {
      expect(lines[i]!.monotonicOffsetMs).toBeGreaterThanOrEqual(lines[i - 1]!.monotonicOffsetMs);
    }

    // Nothing may append to the file after close, even as abandoned sink work settles.
    const after = await readTrace(root, "call_order");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await readTrace(root, "call_order")).toBe(after);
  });
});
