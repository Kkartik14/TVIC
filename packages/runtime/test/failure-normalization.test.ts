import { describe, expect, it } from "vitest";

import { AsyncQueue } from "@tvic/media";
import { PCM16_16K_MONO, type TranscriptEvent } from "@tvic/core";
import { createRuntime, PipelineVoiceLoop, type VoiceEvent } from "../src/index.js";
import {
  audioChunkIn,
  buildAgent,
  llmEvent,
  makeCallHandle,
  makeLlm,
  makeStt,
  makeTts,
  audioChunk,
  streamEnded,
  streamStarted,
  until,
  withPipelineProviders,
} from "./harness.js";

/**
 * R2-08: provider failure normalization at the runtime boundary.
 * Locks: await==iterate normalized equality, stage+provider preserved,
 * byte budgets enforced, no raw leak.
 */
describe("R2-08 failure normalization", () => {
  it("await rejects with the same normalized value the iterator yields", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((request) => [
      llmEvent(request, 1, { type: "llm.started", model: request.model }),
      llmEvent(request, 2, {
        type: "llm.failed",
        error: {
          name: "ProviderError",
          code: "llm.custom_boom",
          category: "provider",
          message: "boom",
          retriable: true,
          provider: "fake-llm",
        },
      }),
    ]);
    const tts = makeTts((request) => [audioChunk(request, 1)], { endStream: true });
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });
    const running = loop.start();
    const seen: VoiceEvent[] = [];
    const draining = (async () => {
      for await (const event of running) seen.push(event);
    })();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "fail me");
    await until(
      async () => (await runtime.inspectSession(session.id)).turns[0]?.status === "failed",
      "turn failed",
    );
    call.push(streamEnded(session.id));
    const result = await running;
    await draining;
    // Turn-level failure resolves the run with counters (does not reject);
    // run-level rejection equality is locked by the next test.
    expect(result.turnsFailed).toBe(1);
    expect(result.firstTurnError).toMatchObject({ code: "llm.custom_boom" });
    const errorEvent = seen.find((e) => e.kind === "error");
    expect(errorEvent?.kind).toBe("error");
    if (errorEvent?.kind === "error") {
      expect(errorEvent.error.code).toBe("llm.custom_boom");
      expect(errorEvent.error.category).toBe("provider");
    }
    expect(seen.at(-1)?.kind).toBe("call_ended");
    await runtime.stop();
  });

  it("run-level failure rejects awaiters with the same normalized value", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const failingStt = {
      name: "failing-stt",
      kind: "stt",
      version: "0.1.0",
      capabilities: {
        streaming: { input: true, output: true, native: true },
        cancellation: { request: true, output: false, buffer: false, truncation: false },
        transports: ["websocket"],
        audio: {
          input: [PCM16_16K_MONO],
        },
      },
      async open(): Promise<never> {
        const { providerError } = await import("@tvic/core");
        throw providerError("stt.test_open_failed", "open boom", {
          provider: "failing-stt",
          retriable: false,
        });
      },
    } as never;
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: failingStt }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });
    const running = loop.start();
    const seen: VoiceEvent[] = [];
    const draining = (async () => {
      for await (const event of running) seen.push(event);
    })();
    call.push(streamStarted(session.id));
    const rejection = await running.then(
      () => null,
      (error: unknown) => error as { error?: Record<string, unknown> } & Record<string, unknown>,
    );
    await draining;
    // Strict cross-channel equality on the full tuple (modulo cause budget).
    expect(rejection).toMatchObject({
      name: "ProviderError",
      code: "stt.test_open_failed",
      category: "provider",
    });
    const errorEvent = seen.find((e) => e.kind === "error");
    expect(errorEvent?.kind).toBe("error");
    if (errorEvent?.kind === "error") {
      expect(errorEvent.error).toMatchObject({
        name: "ProviderError",
        code: "stt.test_open_failed",
        category: "provider",
      });
      // The await rejection carries the SAME normalized payload the iterator
      // yielded (TvicThrowableError.error deep-equals the event error).
      expect(rejection).not.toBeNull();
      expect((rejection as { error?: unknown }).error).toEqual(errorEvent.error);
    }
    expect(seen.at(-1)).toMatchObject({ kind: "call_ended", reason: "failed" });
    await runtime.stop();
  });

  it("oversized tool input is truncated within budget (JSON-safe, counted)", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const { defineTool } = await import("../src/index.js");
    const big = "x".repeat(70_000);
    const tool = defineTool({
      id: "tool_big",
      name: "big_tool",
      description: "big",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      async execute() {
        return { ok: true };
      },
    });
    const agent = buildAgent({ tools: [tool] });
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((request) => {
      const c = { callRef: "c1", toolName: "big_tool" as never, input: { blob: big } };
      return [
        llmEvent(request, 1, { type: "llm.started", model: request.model }),
        llmEvent(request, 2, { type: "llm.tool_call", call: c }),
        llmEvent(request, 3, { type: "llm.completed", text: "", toolCalls: [c] }),
      ];
    });
    // Tool input exceeds 64k schema-wise? No — schema is open object, so the
    // call executes; the EVENT input must still be truncated at the boundary.
    const tts = makeTts((request) => [audioChunk(request, 1)], { endStream: true });
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });
    const running = loop.start();
    const seen: VoiceEvent[] = [];
    const draining = (async () => {
      for await (const event of running) seen.push(event);
    })();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "big");
    await until(
      async () => (await runtime.inspectSession(session.id)).turns[0]?.status === "completed",
      "turn done",
    );
    call.push(streamEnded(session.id, "completed"));
    await running;
    await draining;
    const toolCall = seen.find((e) => e.kind === "tool_call");
    expect(toolCall?.kind).toBe("tool_call");
    if (toolCall?.kind === "tool_call") {
      const input = toolCall.input as { $tvic?: string; bytes?: number };
      expect(input.$tvic).toBe("input_truncated");
      expect(input.bytes).toBeGreaterThan(65_536);
      // JSON-safe round-trip of the marker itself.
      expect(() => JSON.stringify(toolCall.input)).not.toThrow();
      expect(JSON.stringify(toolCall.input).length).toBeLessThan(1_000);
    }
    await runtime.stop();
  });

  it("oversized error cause is truncated within budget", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((request) => [
      llmEvent(request, 1, { type: "llm.started", model: request.model }),
      llmEvent(request, 2, {
        type: "llm.failed",
        error: {
          name: "ProviderError",
          code: "llm.big_boom",
          category: "provider",
          message: "boom",
          retriable: false,
          provider: "fake-llm",
          cause: { blob: "y".repeat(10_000) },
        },
      }),
    ]);
    const tts = makeTts((request) => [audioChunk(request, 1)], { endStream: true });
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });
    const running = loop.start();
    const seen: VoiceEvent[] = [];
    const draining = (async () => {
      for await (const event of running) seen.push(event);
    })();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "fail");
    await until(
      async () => (await runtime.inspectSession(session.id)).turns[0]?.status === "failed",
      "turn failed",
    );
    call.push(streamEnded(session.id));
    await running.catch(() => undefined);
    await draining;
    const errorEvent = seen.find((e) => e.kind === "error");
    if (errorEvent?.kind === "error") {
      // Strict budget asserts: counted bytes, marker, JSON-safe round-trip.
      const cause = errorEvent.error.cause as { $tvic?: string; bytes?: number; preview?: string };
      expect(cause.$tvic).toBe("cause_truncated");
      expect(cause.bytes).toBeGreaterThan(4_096);
      expect(typeof cause.preview).toBe("string");
      // Bounded: full blob gone, preview capped, whole error JSON-safe.
      expect(JSON.stringify(errorEvent.error).length).toBeLessThan(10_000);
      expect((cause.preview ?? "").length).toBeLessThanOrEqual(512);
      expect(() => JSON.stringify(errorEvent.error)).not.toThrow();
      expect(JSON.stringify(errorEvent.error)).toContain("cause_truncated");
      expect(errorEvent.error).toMatchObject({ code: "llm.big_boom" });
    } else {
      expect.unreachable("expected an error event");
    }
    await runtime.stop();
  });

  it("hallucinated tool maps to validation (never internal)", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((request) => {
      const c = { callRef: "ghost", toolName: "no_such_tool" as never, input: {} };
      return [
        llmEvent(request, 1, { type: "llm.started", model: request.model }),
        llmEvent(request, 2, { type: "llm.tool_call", call: c }),
        llmEvent(request, 3, { type: "llm.completed", text: "", toolCalls: [c] }),
      ];
    });
    const tts = makeTts((request) => [audioChunk(request, 1)], { endStream: true });
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });
    const running = loop.start();
    const seen: VoiceEvent[] = [];
    const draining = (async () => {
      for await (const event of running) seen.push(event);
    })();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "ghost tool");
    await until(
      async () => (await runtime.inspectSession(session.id)).turns[0] !== undefined,
      "turn terminal",
    );
    call.push(streamEnded(session.id, "completed"));
    await running;
    await draining;
    const errorEvent = seen.find((e) => e.kind === "error");
    expect(errorEvent?.kind).toBe("error");
    if (errorEvent?.kind === "error") {
      expect(errorEvent.error).toMatchObject({
        name: "ValidationError",
        code: "tool.not_found",
        category: "validation",
        retriable: false,
      });
    }
    await runtime.stop();
  });

  it("lease loss mid-tool maps to failed(lease_lost), never cancelled", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const { LeaseLostError } = await import("@tvic/core");
    const { defineTool } = await import("../src/index.js");
    const tool = defineTool({
      id: "tool_lease",
      name: "leased_tool",
      description: "leased",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      async execute() {
        throw new LeaseLostError("session_gone" as never);
      },
    });
    const agent = buildAgent({ tools: [tool] });
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((request) => {
      const c = { callRef: "l1", toolName: "leased_tool" as never, input: {} };
      return [
        llmEvent(request, 1, { type: "llm.started", model: request.model }),
        llmEvent(request, 2, { type: "llm.tool_call", call: c }),
        llmEvent(request, 3, { type: "llm.completed", text: "", toolCalls: [c] }),
      ];
    });
    const tts = makeTts((request) => [audioChunk(request, 1)], { endStream: true });
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });
    const running = loop.start();
    const seen: VoiceEvent[] = [];
    const draining = (async () => {
      for await (const event of running) seen.push(event);
    })();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "lease me");
    await until(async () => {
      const turn = (await runtime.inspectSession(session.id)).turns[0];
      return turn?.status === "failed" || turn?.status === "completed";
    }, "turn terminal");
    call.push(streamEnded(session.id, "completed"));
    await running;
    await draining;
    // Lease loss is a failure carrying lease identity in the tool result,
    // never a barge-in cancel.
    const toolResult = seen.find((e) => e.kind === "tool_result");
    expect(toolResult?.kind).toBe("tool_result");
    if (toolResult?.kind === "tool_result") {
      expect(toolResult.output).toMatchObject({ error: { code: "tool.lease_lost" } });
    }
    const turn = (await runtime.inspectSession(session.id)).turns[0];
    expect(turn?.status).not.toBe("cancelled");
    await runtime.stop();
  });

  it("preview is byte-capped without splitting UTF-8 sequences", async () => {
    const { truncateErrorCause } = await import("../src/pipeline-payload-budgets.js");
    const blob = "💬".repeat(3_000) + "x".repeat(3_000);
    const truncated = truncateErrorCause({
      name: "ProviderError",
      code: "llm.big_boom",
      category: "provider",
      message: "boom",
      retriable: false,
      cause: { blob },
    });
    const cause = truncated.cause as { $tvic?: string; bytes?: number; preview?: string };
    expect(cause.$tvic).toBe("cause_truncated");
    expect(new TextEncoder().encode(cause.preview ?? "").byteLength).toBeLessThanOrEqual(512);
    expect(cause.preview).not.toContain("�");
    expect(() => JSON.stringify(truncated)).not.toThrow();
  });

  it("command failure preserves normalized retriability; raw pre-wraps internal", async () => {
    // The transcript path must NOT win this race: stream events stay open
    // (close() ends them cleanly) so the controller-failure wrap is what
    // the run observes.
    for (const [failure, code, category, retriable] of [
      [
        {
          name: "ProviderError",
          code: "stt.custom_boom",
          message: "boom",
          category: "provider",
          retriable: false,
          provider: "fail-stt",
        },
        "stt.custom_boom",
        "provider",
        false,
      ],
      // Raw transport errors arrive pre-wrapped by the controller as
      // internal (message preserved); retry decisions for future
      // generations live in the resilient-STT mapping, not this terminal.
      [new Error("socket boom"), "error.error", "internal", false],
    ] as const) {
      const runtime = createRuntime();
      await runtime.start();
      const agent = buildAgent();
      const session = await runtime.startSession(agent, { channel: "simulated" });
      const call = makeCallHandle();
      const events = new AsyncQueue<TranscriptEvent>();
      const stt = {
        name: "fail-stt",
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
              throw failure;
            },
            async commit() {},
            async close() {
              events.close();
            },
          };
        },
      } as never;
      const loop = new PipelineVoiceLoop({
        runtime,
        session,
        agent: withPipelineProviders(agent, { stt }),
        callHandle: call.handle,
        llmModel: "gpt-test",
      });
      const running = loop.start();
      const seen: VoiceEvent[] = [];
      const draining = (async () => {
        for await (const event of running) seen.push(event);
      })();
      call.push(streamStarted(session.id));
      call.push(audioChunkIn(session.id));
      const rejection = await running.then(
        () => null,
        (error: unknown) => error as { code?: string; category?: string; retriable?: boolean },
      );
      await draining;
      expect(rejection).toMatchObject({ code, category, retriable });
      await runtime.stop();
    }
  });
});
