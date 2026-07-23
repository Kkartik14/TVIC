import { describe, expect, it } from "vitest";

import { createInMemoryMemory } from "@tvic/dal";
import { internalError, type SessionId } from "@tvic/core";

import { PipelineVoiceLoop } from "../src/index.js";
// debugStats() is a diagnostics-only hook on the internal impl — reach it via the
// internal module, not the public surface.
import { InMemoryRuntime } from "../src/create-runtime.js";
import {
  audioChunk,
  buildAgent,
  committed,
  llmEvent,
  makeBlockingLlm,
  makeCallHandle,
  makeLlm,
  makeStt,
  makeTts,
  streamEnded,
  streamStarted,
  until,
} from "./harness.js";

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Mode = "ok" | "fail" | "stall" | "hangup_mid" | "dropped";

async function runCall(runtime: InMemoryRuntime, mode: Mode): Promise<void> {
  const agent = buildAgent();
  const session = await runtime.startSession(agent, { channel: "simulated" });
  const sid = session.id as SessionId;
  const call = makeCallHandle(mode === "dropped" ? { playout: "dropped" } : {});
  const stt = makeStt();
  const blocking = makeBlockingLlm();
  const llm =
    mode === "stall"
      ? blocking.provider
      : makeLlm((req) =>
          mode === "fail"
            ? [
                llmEvent(req, 1, { type: "llm.started", model: req.model }),
                llmEvent(req, 2, {
                  type: "llm.failed",
                  error: {
                    code: "llm.boom",
                    message: "boom",
                    category: "provider",
                    retriable: false,
                  },
                }),
              ]
            : [
                llmEvent(req, 1, { type: "llm.started", model: req.model }),
                llmEvent(req, 2, { type: "llm.completed", text: "ok", toolCalls: [] }),
              ],
        );
  const tts = makeTts((req) => [audioChunk(req, 1), committed(req)], { endStream: true });
  const memory = createInMemoryMemory();

  let endReason: "completed" | "failed" = "completed";
  try {
    const running = new PipelineVoiceLoop({
      runtime,
      session,
      agent,
      callHandle: call.handle,
      stt: stt.provider,
      llm,
      tts,
      llmModel: "gpt-test",
      memory,
      streamStallTimeoutMs: 20,
    }).run();

    call.push(streamStarted(sid));
    if (mode === "hangup_mid") {
      stt.pushFinal(sid, "hi");
      call.push(streamEnded(sid)); // hang up immediately, mid-turn
    } else {
      stt.pushFinal(sid, "hi");
      await until(async () => {
        const turns = (await runtime.inspectSession(sid)).turns;
        const status = turns[0]?.status;
        return (
          turns.length >= 1 &&
          (status === "completed" || status === "cancelled" || status === "failed")
        );
      }, "turn terminal");
      call.push(streamEnded(sid));
    }
    const result = await running;
    if (result.turnsFailed > 0) {
      endReason = "failed";
    }
  } catch {
    endReason = "failed";
  } finally {
    await runtime.endSession(
      sid,
      endReason === "failed"
        ? { reason: "failed", error: internalError("chaos.call_failed", "call failed") }
        : { reason: "completed" },
    );
  }
}

describe("long-run leak / chaos", () => {
  it("runs many randomized calls without leaking per-call state", async () => {
    const runtime = new InMemoryRuntime();
    await runtime.start();
    const rng = mulberry32(42);
    const modes: Mode[] = ["ok", "fail", "stall", "hangup_mid", "dropped"];

    for (let i = 0; i < 100; i += 1) {
      const mode = modes[Math.floor(rng() * modes.length)]!;
      await runCall(runtime, mode).catch((error) => {
        throw new Error(`call ${i} (${mode}): ${String(error)}`);
      });
    }

    // After every call ended, no per-call state is retained.
    const stats = runtime.debugStats();
    expect(stats.activeSessionClocks).toBe(0);

    await runtime.stop();
  });
});
