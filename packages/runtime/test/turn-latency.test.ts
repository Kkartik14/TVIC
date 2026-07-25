import { describe, expect, it } from "vitest";

import { createRuntime, PipelineVoiceLoop, type TurnLatencyRecord } from "../src/index.js";
import {
  audioChunk,
  audioChunkIn,
  buildAgent,
  llmEvent,
  makeCallHandle,
  makeControlledTts,
  makeLlm,
  makeStt,
  makeTts,
  streamEnded,
  streamStarted,
  until,
  withPipelineProviders,
} from "./harness.js";

/**
 * Latency reporting exists so the endpoint wait stops being invisible. Anchoring
 * every stage at the endpoint commit is the point: measuring from internal turn
 * setup hides the single largest contributor to what a caller experiences.
 */
describe("turn latency", () => {
  it("anchors stage timing at the endpoint commit and reports the endpoint wait", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });

    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((req) => [
      llmEvent(req, 1, { type: "llm.started", model: req.model }),
      llmEvent(req, 2, { type: "llm.token", text: "Booked." }),
      llmEvent(req, 3, { type: "llm.completed", text: "Booked.", toolCalls: [] }),
    ]);
    const tts = makeTts((req) => [audioChunk(req, 1)], { endStream: true });

    const records: TurnLatencyRecord[] = [];
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle: call.handle,
      llmModel: "gpt-test",
      turnEndpointTimeoutMs: 5_000,
      onTurnLatency: (record) => records.push(record),
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    call.push(audioChunkIn(session.id));

    // Speech start, then an immutable final, then a measurable gap before the
    // provider decides the utterance is over. That gap is the endpoint wait.
    stt.pushSpeechStarted(session.id);
    stt.pushFinalSegment(session.id, "book a table for two");
    await new Promise((resolve) => setTimeout(resolve, 30));
    stt.pushEndpoint(session.id);

    await until(() => call.sent.length >= 1, "agent audio sent");
    call.push(streamEnded(session.id));
    await running;

    const turn = (await runtime.inspectSession(session.id)).turns[0];
    expect(turn?.status).toBe("completed");

    const latency = turn?.latency;
    expect(latency?.endpointMs).toBeGreaterThanOrEqual(20);
    expect(latency?.listenedMs).toBeGreaterThanOrEqual(latency?.endpointMs ?? 0);

    // Anchored at the endpoint, so stage timing excludes the wait that preceded it.
    // A consumer adds the two to get perceived caller-to-audio delay.
    expect(latency?.firstAudioMs).toBeLessThan(latency?.endpointMs ?? 0);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      sessionId: session.id,
      turnId: turn?.id,
      sequence: 1,
      status: "completed",
    });
  });

  it("reports the interruption tail on a barged-in turn", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent({
      interruptionPolicy: { mode: "graceful", minSpeechMs: 0, trimOutputOnInterrupt: true },
    });
    const session = await runtime.startSession(agent, { channel: "simulated" });

    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((req) => [
      llmEvent(req, 1, { type: "llm.started", model: req.model }),
      llmEvent(req, 2, { type: "llm.completed", text: "A long spoken answer.", toolCalls: [] }),
    ]);
    const tts = makeControlledTts();

    const records: TurnLatencyRecord[] = [];
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts: tts.provider }),
      callHandle: call.handle,
      llmModel: "gpt-test",
      onTurnLatency: (record) => records.push(record),
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "start talking");

    await until(() => tts.ready, "tts started");
    tts.pushChunk(1);
    await until(() => call.sent.length >= 1, "agent audio sent");

    stt.pushSpeechStarted(session.id);
    await until(() => call.clearCalls >= 1, "output cleared");
    call.push(streamEnded(session.id));
    await running;

    const turn = (await runtime.inspectSession(session.id)).turns[0];
    expect(turn?.status).toBe("cancelled");
    expect(typeof turn?.latency.interruptionTailMs).toBe("number");
    expect(turn?.latency.interruptionTailMs).toBeGreaterThanOrEqual(0);
    expect(records.at(-1)?.status).toBe("cancelled");
  });

  it("survives an observer that throws, because it only watches the call", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });

    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((req) => [
      llmEvent(req, 1, { type: "llm.started", model: req.model }),
      llmEvent(req, 2, { type: "llm.completed", text: "Fine.", toolCalls: [] }),
    ]);
    const tts = makeTts((req) => [audioChunk(req, 1)], { endStream: true });

    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle: call.handle,
      llmModel: "gpt-test",
      onTurnLatency: () => {
        throw new Error("observer blew up");
      },
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "hello");
    await until(() => call.sent.length >= 1, "agent audio sent");
    call.push(streamEnded(session.id));

    const result = await running;
    expect(result.turnsFailed).toBe(0);
    expect((await runtime.inspectSession(session.id)).turns[0]?.status).toBe("completed");
  });

  it("summarises a run of turns as p50/p95/p99 for each stage", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });

    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((req) => [
      llmEvent(req, 1, { type: "llm.started", model: req.model }),
      llmEvent(req, 2, { type: "llm.completed", text: "Done.", toolCalls: [] }),
    ]);
    const tts = makeTts((req) => [audioChunk(req, 1)], { endStream: true });

    const records: TurnLatencyRecord[] = [];
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle: call.handle,
      llmModel: "gpt-test",
      onTurnLatency: (record) => records.push(record),
    });

    const running = loop.run();
    call.push(streamStarted(session.id));

    const turns = 12;
    for (let i = 0; i < turns; i += 1) {
      stt.pushFinal(session.id, `request ${i}`);
      await until(() => call.sent.length >= i + 1, `turn ${i} audio sent`);
    }
    call.push(streamEnded(session.id));
    await running;

    expect(records).toHaveLength(turns);
    expect(records.every((record) => record.status === "completed")).toBe(true);

    const summary = summarise(records);
    expect(summary.firstAudioMs.p50).toBeGreaterThanOrEqual(0);
    expect(summary.firstAudioMs.p99).toBeGreaterThanOrEqual(summary.firstAudioMs.p50);
    expect(summary.totalMs.count).toBe(turns);
  });
});

type Stage = "listenedMs" | "endpointMs" | "firstTokenMs" | "firstAudioMs" | "totalMs";

const STAGES: readonly Stage[] = [
  "listenedMs",
  "endpointMs",
  "firstTokenMs",
  "firstAudioMs",
  "totalMs",
];

interface StageSummary {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

/**
 * Offline latency summary over recorded turns. Percentiles are nearest-rank on the
 * sorted sample, which is the honest choice for the small runs a test produces:
 * interpolation would invent values between observations that never occurred.
 */
function summarise(records: readonly TurnLatencyRecord[]): Record<Stage, StageSummary> {
  const summary = {} as Record<Stage, StageSummary>;
  for (const stage of STAGES) {
    const samples = records
      .map((record) => record.latency[stage])
      .filter((value): value is number => typeof value === "number")
      .sort((a, b) => a - b);
    summary[stage] = {
      count: samples.length,
      p50: percentile(samples, 0.5),
      p95: percentile(samples, 0.95),
      p99: percentile(samples, 0.99),
    };
  }
  return summary;
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? 0;
}
