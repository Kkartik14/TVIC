import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { listCalls, loadAudioTrack, loadCall } from "../lib/artifacts";

describe("artifact path safety", () => {
  it("rejects call ids that escape the calls root", async () => {
    await expect(loadCall("..")).rejects.toThrow(/Unsafe call id/);
    await expect(loadCall(".")).rejects.toThrow(/Unsafe call id/);
    // A separator fails the character allowlist before any filesystem access.
    await expect(loadCall("../../etc/passwd")).rejects.toThrow(/Unsafe call id/);
    await expect(loadAudioTrack("..", "input")).rejects.toThrow(/Unsafe call id/);
  });
});

describe("degraded artifacts", () => {
  const previous = process.env.CALLS_DIR;
  afterEach(() => {
    if (previous === undefined) {
      delete process.env.CALLS_DIR;
    } else {
      process.env.CALLS_DIR = previous;
    }
  });

  const event = {
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

  it("marks a call with a missing manifest as degraded", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvic-viewer-"));
    process.env.CALLS_DIR = root;
    const dir = join(root, "call_no_manifest");
    await mkdir(dir, { recursive: true });
    // A trace exists but the manifest was never finalized (close() never completed).
    await writeFile(join(dir, "call.jsonl"), `${JSON.stringify(event)}\n`, "utf8");

    const summary = (await listCalls()).find((call) => call.callId === "call_no_manifest");
    expect(summary?.degraded).toBe(true);
  });
});
