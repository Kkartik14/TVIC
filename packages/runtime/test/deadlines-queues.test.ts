import { describe, expect, it } from "vitest";

import { AsyncQueue } from "@tvic/media";
import { PCM16_16K_MONO, type TranscriptEvent } from "@tvic/core";
import { createRuntime, createSttSession, PipelineVoiceLoop } from "../src/index.js";
import { SerialSttCommandController } from "../src/stt-command-controller.js";
import {
  audioChunk,
  audioChunkIn,
  buildAgent,
  committed,
  llmEvent,
  makeBlockingLlm,
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
 * R2-05: deadlines, stalls, and bounded queues.
 * Locks: stall timeouts, startup/commit timeouts (both commit modes),
 * late-message drop, overflow terminal, AsyncQueue bound semantics.
 */
describe("R2-05 deadlines and queues", () => {
  it("stalled LLM fails the turn bounded (fail mode)", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    const blocking = makeBlockingLlm();
    const tts = makeTts((request) => [audioChunk(request, 1)], { endStream: true });
    const running = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm: blocking.provider, tts }),
      callHandle: call.handle,
      llmModel: "gpt-test",
      streamStallTimeoutMs: 50,
    }).run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "hello?");
    await until(
      async () => (await runtime.inspectSession(session.id)).turns[0]?.status === "failed",
      "llm stall fails turn",
    );
    expect(blocking.completeCalled).toBe(true);
    call.push(streamEnded(session.id));
    await running;
    expect(blocking.cancelled).toBe(true);
    await runtime.stop();
  }, 10_000);

  it("stalled TTS stream fails bounded", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((request) => [
      llmEvent(request, 1, { type: "llm.completed", text: "answer", toolCalls: [] }),
    ]);
    // Opens but never emits audio events -> playback stall fires.
    // NOTE: playback stall is caught by the audio branch (not the turn
    // catch), so the turn terminalizes cancelled(not_heard-transport_lost),
    // while the `tts.stalled` error is preserved as the audio error.
    const tts = makeControlledTts();
    const running = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts: tts.provider }),
      callHandle: call.handle,
      llmModel: "gpt-test",
      streamStallTimeoutMs: 50,
    }).run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "go");
    await until(() => tts.ready, "tts opened");
    await until(
      async () => (await runtime.inspectSession(session.id)).turns[0]?.status === "cancelled",
      "tts stall cancels turn",
    );
    call.push(streamEnded(session.id));
    await running;
    await runtime.stop();
  }, 10_000);

  it("STT session open times out bounded", async () => {
    const hanging = {
      name: "hanging-stt",
      kind: "stt",
      version: "0.1.0",
      capabilities: {
        streaming: { input: true, output: true, native: true },
        cancellation: { request: true, output: false, buffer: false, truncation: false },
        transports: ["websocket"],
        audio: { input: [PCM16_16K_MONO] },
      },
      async open(): Promise<never> {
        return new Promise<never>(() => {});
      },
    } as never;
    await expect(
      createSttSession({
        provider: hanging,
        format: PCM16_16K_MONO,
        openTimeoutMs: 20,
      }),
    ).rejects.toMatchObject({ code: "stt.open_timeout" });
  });

  it("commit timeout fires in provider mode; none mode resolves locally", async () => {
    const hangingStream = {
      events: (async function* () {})(),
      commitMode: "provider",
      async sendAudio() {},
      async commit(): Promise<never> {
        return new Promise<never>(() => {});
      },
      async close() {},
    } as never;
    const controller = new SerialSttCommandController({
      stream: hangingStream,
      commitTimeoutMs: 20,
    });
    await expect(controller.admitCommit()).rejects.toMatchObject({ code: "stt.commit_timeout" });
    await controller.abort().catch(() => undefined);

    const noneStream = {
      events: (async function* () {})(),
      commitMode: "none",
      commitCalls: 0,
      async sendAudio() {},
      async commit() {
        (this as { commitCalls: number }).commitCalls += 1;
      },
      async close() {},
    } as never;
    const noneController = new SerialSttCommandController({
      stream: noneStream,
      commitTimeoutMs: 20,
    });
    await expect(noneController.admitCommit()).resolves.toBeUndefined();
    expect((noneStream as unknown as { commitCalls: number }).commitCalls).toBe(0);
    await noneController.abort().catch(() => undefined);
  });

  it("late STT final after media end never creates a post-shutdown turn", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((request) => [
      llmEvent(request, 1, { type: "llm.completed", text: "hi", toolCalls: [] }),
    ]);
    const tts = makeTts((request) => [audioChunk(request, 1)], { endStream: true });
    const running = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    }).run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "one");
    await until(
      async () => (await runtime.inspectSession(session.id)).turns.length === 1,
      "first turn",
    );
    call.push(streamEnded(session.id, "completed"));
    await running;
    // Late provider final after the run settled: must not create a turn.
    stt.pushFinal(session.id, "late ghost");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await runtime.inspectSession(session.id)).turns.length).toBe(1);
    await runtime.stop();
  });

  it("run-events queue overflow fails terminal (slow consumer)", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((request) => [
      llmEvent(request, 1, { type: "llm.completed", text: "flood", toolCalls: [] }),
    ]);
    const chunks = Array.from({ length: 1100 }, (_, i) => i + 1);
    const tts = makeTts(
      (request) => [...chunks.map((s) => audioChunk(request, s)), committed(request)],
      {
        endStream: true,
      },
    );
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });
    // Await only, never iterate: the 1024-bound must trip, never grow unbounded.
    // A second run proves the iterator channel: it throws the same overflow.
    const running = loop.start();
    void running.catch(() => undefined);
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "flood");
    await until(() => call.sent.length >= 1024, "flooded past bound");
    call.push(streamEnded(session.id, "completed"));
    await expect(running).rejects.toMatchObject({ code: "voice_runtime.events_overflow" });
    await runtime.stop();
  });

  it("run-events overflow fails iterators with the same overflow (no call_ended)", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((request) => [
      llmEvent(request, 1, { type: "llm.completed", text: "flood", toolCalls: [] }),
    ]);
    const chunks = Array.from({ length: 1100 }, (_, i) => i + 1);
    const tts = makeTts(
      (request) => [...chunks.map((s) => audioChunk(request, s)), committed(request)],
      {
        endStream: true,
      },
    );
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });
    const running = loop.start();
    // No iterator yet: let the flood trip the bound, then prove a LATE
    // iterator observes the same terminal failure (call_ended WAIVED here).
    void running.catch(() => undefined);
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "flood");
    await until(() => call.sent.length >= 1024, "flooded past bound");
    call.push(streamEnded(session.id, "completed"));
    const rejection = await running.then(
      () => null,
      (error: unknown) => error as { code?: string },
    );
    expect(rejection?.code).toBe("voice_runtime.events_overflow");
    const kinds: string[] = [];
    const thrown = await (async () => {
      for await (const event of running) {
        kinds.push(event.kind);
      }
      return null;
    })().then(
      () => null,
      (error: unknown) => error as { code?: string },
    );
    // Same terminal value on both channels (deep-equal codes, WAIVED call_ended).
    expect(thrown?.code).toBe(rejection?.code);
    expect(kinds).not.toContain("call_ended");
    await runtime.stop();
  }, 15_000);

  it("AsyncQueue bound returns false instead of growing (never silent drop contract)", () => {
    const queue = new AsyncQueue<number>({ maxBuffered: 2 });
    expect(queue.push(1)).toBe(true);
    expect(queue.push(2)).toBe(true);
    expect(queue.push(3)).toBe(false);
    queue.close();
  });

  it("stt-session forward queue overflows terminal on flood", async () => {
    const { pushable } = await import("./harness.js");
    const { createSttSession } = await import("../src/index.js");
    const { PCM16_16K_MONO: FORMAT } = await import("@tvic/core");
    const providerEvents = pushable<never>();
    const fake = {
      name: "flood-stt",
      kind: "stt",
      version: "0.1.0",
      capabilities: {
        streaming: { input: true, output: true, native: true },
        cancellation: { request: true, output: false, buffer: false, truncation: false },
        transports: ["websocket"],
        audio: { input: [FORMAT] },
      },
      async open() {
        return {
          events: providerEvents.iterable,
          async sendAudio() {},
          async commit() {},
          async close() {},
        };
      },
    } as never;
    const session = await createSttSession({ provider: fake, format: FORMAT });
    // Flood 1,026 provider events, hold the first while the forwarder runs
    // ahead: the session queue (1,024) must fail terminal with the canonical
    // session code, never grow.
    for (let i = 0; i < 1_026; i += 1) {
      providerEvents.push({
        id: `e${i}`,
        type: "stt.partial",
        direction: "input",
        sessionId: session.sessionId,
        sequence: i,
        provider: "flood-stt",
        text: `w${i}`,
        startTimestamp: "2026-05-20T00:00:00.000Z",
        endTimestamp: "2026-05-20T00:00:00.000Z",
      } as never);
    }
    const iter = session.events[Symbol.asyncIterator]();
    await iter.next();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(iter.next()).rejects.toMatchObject({ code: "stt.session_buffer_overflow" });
    await session.close().catch(() => undefined);
  });

  it("stt-session fences foreign session identity with identity_mismatch", async () => {
    const { pushable } = await import("./harness.js");
    const { createSttSession } = await import("../src/index.js");
    const { PCM16_16K_MONO: FORMAT } = await import("@tvic/core");
    const providerEvents = pushable<never>();
    const fake = {
      name: "identity-stt",
      kind: "stt",
      version: "0.1.0",
      capabilities: {
        streaming: { input: true, output: true, native: true },
        cancellation: { request: true, output: false, buffer: false, truncation: false },
        transports: ["websocket"],
        audio: { input: [FORMAT] },
      },
      async open() {
        return {
          events: providerEvents.iterable,
          async sendAudio() {},
          async commit() {},
          async close() {},
        };
      },
    } as never;
    const session = await createSttSession({ provider: fake, format: FORMAT });
    providerEvents.push({
      id: "foreign-1",
      type: "stt.partial",
      direction: "input",
      sessionId: "session_someone_else",
      sequence: 1,
      provider: "identity-stt",
      text: "intruder",
      startTimestamp: "2026-05-20T00:00:00.000Z",
      endTimestamp: "2026-05-20T00:00:00.000Z",
    } as never);
    await expect(
      (async () => {
        for await (const _ of session.events) {
          // Must never yield the foreign event.
        }
      })(),
    ).rejects.toMatchObject({ code: "provider.identity_mismatch" });
    await session.close().catch(() => undefined);
  });

  it("same-tick double endpoint commits exactly one turn", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((request) => [
      llmEvent(request, 1, { type: "llm.completed", text: "hi", toolCalls: [] }),
    ]);
    const tts = makeTts((request) => [audioChunk(request, 1)], { endStream: true });
    const running = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    }).run();
    call.push(streamStarted(session.id));
    stt.pushFinalSegment(session.id, "once");
    stt.pushEndpoint(session.id);
    stt.pushEndpoint(session.id);
    await until(
      async () => (await runtime.inspectSession(session.id)).turns.length >= 1,
      "one turn",
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await runtime.inspectSession(session.id)).turns.length).toBe(1);
    call.push(streamEnded(session.id, "completed"));
    await running;
    await runtime.stop();
  });

  it("chain continues after a failed turn (rejection continuity)", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    let n = 0;
    const llm = makeLlm((request) => {
      n += 1;
      if (n === 1) {
        return [
          llmEvent(request, 1, { type: "llm.started", model: request.model }),
          llmEvent(request, 2, {
            type: "llm.failed",
            error: { code: "llm.boom", message: "boom", category: "provider", retriable: false },
          }),
        ];
      }
      return [llmEvent(request, 3, { type: "llm.completed", text: "recovered", toolCalls: [] })];
    });
    const tts = makeTts((request) => [audioChunk(request, 1)], { endStream: true });
    const running = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    }).run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "first fails");
    await until(
      async () => (await runtime.inspectSession(session.id)).turns[0]?.status === "failed",
      "first failed",
    );
    stt.pushFinal(session.id, "second works");
    await until(
      async () => (await runtime.inspectSession(session.id)).turns[1]?.status === "completed",
      "second completed",
    );
    call.push(streamEnded(session.id, "completed"));
    const result = await running;
    expect(result.turnsHandled).toBe(2);
    expect(result.turnsFailed).toBe(1);
    await runtime.stop();
  });

  it("transcript drain timeout bounds a never-closing provider (non-retriable)", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const events = new AsyncQueue<TranscriptEvent>();
    const stt = {
      name: "never-closing-stt",
      kind: "stt",
      version: "0.1.0",
      capabilities: {
        streaming: { input: true, output: true, native: true },
        cancellation: { request: true, output: false, buffer: false, truncation: false },
        transports: ["websocket"],
        audio: { input: [PCM16_16K_MONO] },
      },
      async open() {
        return {
          events,
          async sendAudio() {},
          async commit() {},
          // Never ends the event stream: drain must time out instead.
          async close() {},
        };
      },
    } as never;
    const llm = makeLlm((request) => [
      llmEvent(request, 1, { type: "llm.completed", text: "hi", toolCalls: [] }),
    ]);
    const tts = makeTts((request) => [audioChunk(request, 1)], { endStream: true });
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });
    void llm;
    void tts;
    const running = loop.start();
    const seen: string[] = [];
    let recoverable: boolean | undefined;
    const draining = (async () => {
      for await (const event of running) {
        seen.push(event.kind);
        if (event.kind === "error") recoverable = event.recoverable;
      }
    })();
    call.push(streamStarted(session.id));
    call.push(streamEnded(session.id, "completed"));
    await expect(running).rejects.toMatchObject({ code: "stt.drain_timeout" });
    await draining;
    // Post-shutdown housekeeping timeout: explicitly non-retriable.
    expect(recoverable).toBe(false);
    expect(seen.at(-1)).toBe("call_ended");
    await runtime.stop();
  }, 15_000);

  it("does not resolve when a provider command misses the graceful drain budget", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const events = new AsyncQueue<TranscriptEvent>();
    const stt = {
      name: "blocked-send-stt",
      kind: "stt",
      version: "0.1.0",
      capabilities: {
        streaming: { input: true, output: true, native: true },
        cancellation: { request: true, output: false, buffer: false, truncation: false },
        transports: ["websocket"],
        audio: { input: [PCM16_16K_MONO] },
      },
      async open() {
        return {
          events,
          async sendAudio() {
            await new Promise<void>(() => undefined);
          },
          async commit() {},
          async close() {
            events.close();
          },
        };
      },
    } as never;
    const running = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    }).run();

    call.push(streamStarted(session.id));
    call.push(audioChunkIn(session.id));
    call.push(streamEnded(session.id, "completed"));

    await expect(running).rejects.toMatchObject({
      code: "stt.send_timeout",
      category: "timeout",
    });
    await runtime.stop();
  }, 15_000);
});
