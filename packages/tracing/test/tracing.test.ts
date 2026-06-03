import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import type {
  AgentId,
  CallId,
  CorrelationId,
  PayloadRef,
  SessionId,
  SpanId,
  Timestamp,
  TraceEvent,
  TraceEventId,
  TraceId,
} from "@tvic/core";
import { PCM16_16K_MONO } from "@tvic/core";

import {
  JsonlTraceExporter,
  LocalCallArtifactWriter,
  callArtifactDirectory,
  createInMemoryTraceStore,
  deleteCallArtifacts,
  pruneExpiredCallArtifacts,
  traceTypes,
} from "../src/index.js";

function sessionCreated(id: string, sessionId: string): TraceEvent {
  return {
    id: id as TraceEventId,
    traceId: "trace_1" as TraceId,
    sessionId: sessionId as SessionId,
    timestamp: "2026-05-20T00:00:00.000Z" as Timestamp,
    monotonicOffsetMs: 0,
    spanId: "span_1" as SpanId,
    correlationId: "correlation_1" as CorrelationId,
    type: "session.created",
    status: "succeeded",
    agentId: "agent_1" as AgentId,
  };
}

describe("InMemoryTraceStore", () => {
  it("queries by session and type", async () => {
    const store = createInMemoryTraceStore();
    const first = sessionCreated("event_1", "session_1");
    const second = sessionCreated("event_2", "session_2");

    await store.append(first);
    await store.append(second);

    const events = await store.query({
      sessionId: "session_1" as SessionId,
      types: ["session.created"],
    });

    expect(events).toEqual([first]);
    expect(traceTypes(events)).toEqual(["session.created"]);
  });

  it("queries by explicit span and monotonic offset range", async () => {
    const store = createInMemoryTraceStore();
    const first = sessionCreated("event_1", "session_1");
    const second: TraceEvent = {
      ...sessionCreated("event_2", "session_1"),
      monotonicOffsetMs: 50,
      spanId: "span_2" as SpanId,
    };

    await store.append(first);
    await store.append(second);

    await expect(
      store.query({
        sessionId: "session_1" as SessionId,
        spanId: "span_2" as SpanId,
        monotonicSinceMs: 25,
      }),
    ).resolves.toEqual([second]);
  });

  it("writes per-call trace and audio manifest artifacts", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "tvic-artifacts-"));
    const writer = new LocalCallArtifactWriter({
      rootDir,
      callId: "call_1" as CallId,
      sessionId: "session_1" as SessionId,
      traceId: "trace_1" as TraceId,
      createdAt: "2026-05-20T00:00:00.000Z" as Timestamp,
      privacy: {
        consentMode: "record",
        persistAudio: true,
        redactPii: true,
      },
    });

    await writer.export([sessionCreated("event_1", "session_1")]);
    await writer.appendAudio({
      payloadRef: "payload_1" as PayloadRef,
      direction: "input",
      bytes: new Uint8Array([1, 2, 3, 4]),
      monotonicOffsetMs: 10,
      durationMs: 20,
      format: PCM16_16K_MONO,
    });
    await writer.close();

    const manifest = JSON.parse(
      await readFile(join(rootDir, "call_1", "manifest.json"), "utf8"),
    ) as { payloads: readonly [{ readonly byteRange: { readonly endExclusive: number } }] };
    const trace = await readFile(join(rootDir, "call_1", "call.jsonl"), "utf8");

    expect(trace).toContain("session.created");
    expect(manifest.payloads[0]?.byteRange.endExclusive).toBe(4);
  });

  it("rejects unsafe call artifact ids before file operations", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "tvic-artifacts-safe-"));

    expect(() => callArtifactDirectory(rootDir, "../escape" as CallId)).toThrow(
      "Unsafe call artifact id",
    );
    await expect(deleteCallArtifacts({ rootDir, callId: "../escape" as CallId })).rejects.toThrow(
      "Unsafe call artifact id",
    );
  });

  it("creates parent directories for JSONL trace exports", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "tvic-jsonl-"));
    const path = join(rootDir, "nested", "call.jsonl");
    const exporter = new JsonlTraceExporter({ path });

    await exporter.export([sessionCreated("event_1", "session_1")]);
    await exporter.close();

    await expect(readFile(path, "utf8")).resolves.toContain("session.created");
  });

  it("prunes expired call artifacts by retention policy", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "tvic-retention-"));
    const writer = new LocalCallArtifactWriter({
      rootDir,
      callId: "call_1" as CallId,
      sessionId: "session_1" as SessionId,
      traceId: "trace_1" as TraceId,
      createdAt: "2026-05-20T00:00:00.000Z" as Timestamp,
      privacy: {
        consentMode: "record",
        persistAudio: false,
        redactPii: true,
        retentionMs: 0,
      },
    });

    await writer.export([sessionCreated("event_1", "session_1")]);
    await writer.close();
    const deleted = await pruneExpiredCallArtifacts({
      rootDir,
      now: new Date("2026-05-20T00:00:01.000Z"),
    });

    expect(deleted).toEqual(["call_1"]);
    await expect(readFile(join(rootDir, "call_1", "manifest.json"), "utf8")).rejects.toThrow();
  });
});

describe("LocalCallArtifactWriter manifest integrity", () => {
  it("writes integrity:incomplete and omits identity when no event was exported", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "tvic-noid-"));
    const writer = new LocalCallArtifactWriter({
      rootDir,
      callId: "call_noid" as CallId,
      createdAt: "2026-05-20T00:00:00.000Z" as Timestamp,
      privacy: { consentMode: "record", persistAudio: false, redactPii: false },
    });
    await writer.close(); // never exported a trace event → identity unknown

    const manifest = JSON.parse(
      await readFile(join(rootDir, "call_noid", "manifest.json"), "utf8"),
    ) as { sessionId?: string; traceId?: string; integrity?: string };
    // No fake "unknown" branded ids — the fields are simply absent, and integrity is honest.
    expect(manifest.sessionId).toBeUndefined();
    expect(manifest.traceId).toBeUndefined();
    expect(manifest.integrity).toBe("incomplete");
  });

  it("writes real identity + integrity:complete after a session.created export", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "tvic-id-"));
    const writer = new LocalCallArtifactWriter({
      rootDir,
      callId: "call_id" as CallId,
      createdAt: "2026-05-20T00:00:00.000Z" as Timestamp,
      privacy: { consentMode: "record", persistAudio: false, redactPii: false },
    });
    await writer.export([sessionCreated("event_1", "session_1")]);
    await writer.close();

    const manifest = JSON.parse(
      await readFile(join(rootDir, "call_id", "manifest.json"), "utf8"),
    ) as { sessionId?: string; traceId?: string; integrity?: string };
    expect(manifest.sessionId).toBe("session_1");
    expect(manifest.traceId).toBe("trace_1");
    expect(manifest.integrity).toBe("complete");
  });
});

describe("TraceExporter durability contract", () => {
  it("JsonlTraceExporter: export() accepts, flush() durably writes", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "tvic-exporter-"));
    const path = join(rootDir, "call.jsonl");
    const exporter = new JsonlTraceExporter({ path });

    await exporter.export([sessionCreated("event_1", "session_1")]);
    // Durability is promised by flush()/close(), not by export() alone.
    await exporter.flush();
    await expect(readFile(path, "utf8")).resolves.toContain("session.created");
    await exporter.close();
  });
});
