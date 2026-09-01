import { describe, expect, it } from "vitest";

import type { SessionId, ToolCallId, ToolDefinition, ToolId, ToolName, TurnId } from "@tvic/core";

import {
  InMemoryToolIdempotencyStore,
  createToolRegistry,
  executeTool,
  stableStringify,
  validateJsonSchemaSubset,
} from "../src/index.js";

const sessionId = "session_1" as SessionId;
const turnId = "turn_1" as TurnId;
const toolCallId = "tool_call_1" as ToolCallId;

const tool: ToolDefinition<{ name: string }, { greeting: string }> = {
  id: "tool_1" as ToolId,
  name: "greet" as ToolName,
  description: "Greet a caller",
  version: "0.1.0",
  inputSchema: {
    type: "object",
    required: ["name"],
    properties: { name: { type: "string" } },
  },
  outputSchema: { type: "object" },
  timeout: { timeoutMs: 1000, onTimeout: "fail" },
  retry: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0, backoff: "fixed", jitter: false },
  idempotency: { enabled: false },
  async execute(input) {
    return { greeting: `hello ${input.name}` };
  },
};

describe("tools", () => {
  it("registers and retrieves tools", () => {
    const registry = createToolRegistry([tool as ToolDefinition]);
    expect(registry.get(tool.id)).toBe(tool);
  });

  it("validates object schemas", () => {
    expect(validateJsonSchemaSubset({}, tool.inputSchema)).toMatchObject({
      valid: false,
      errors: ["$.name is required"],
    });
  });

  it("validates enums, numeric bounds, and additionalProperties", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        size: { type: "integer", minimum: 1, maximum: 8 },
        when: { enum: ["lunch", "dinner"] },
      },
    } as const;
    expect(validateJsonSchemaSubset({ size: 4, when: "dinner" }, schema).valid).toBe(true);
    expect(validateJsonSchemaSubset({ size: 12, when: "brunch" }, schema).errors).toEqual([
      "$.size must be <= 8",
      '$.when must be one of ["lunch","dinner"]',
    ]);
    expect(validateJsonSchemaSubset({ size: 2, extra: 1 }, schema).errors).toEqual([
      "$.extra is not an allowed property",
    ]);
  });

  it("handles cyclic schema comparisons without overflowing the stack", () => {
    const actual: Record<string, unknown> = {};
    actual.self = actual;
    const expected: Record<string, unknown> = {};
    expected.self = expected;

    expect(validateJsonSchemaSubset(actual, { const: expected })).toEqual({
      valid: true,
      errors: [],
    });
    expect(validateJsonSchemaSubset(actual, { enum: [{ different: true }] })).toMatchObject({
      valid: false,
    });
  });

  it("rejects non-JSON values from canonical serialization", () => {
    expect(() => stableStringify(1n)).toThrow(/bigint/);
    expect(() => stableStringify(new Date("invalid"))).toThrow(/non-JSON object/);
    expect(() => stableStringify([,])).not.toThrow();
    expect(stableStringify([,])).toBe("[null]");
  });

  it("rejects undefined nested in tool input before execution", async () => {
    let executed = false;
    const inputTool: ToolDefinition<unknown, { ok: boolean }> = {
      ...tool,
      inputSchema: { type: "object" },
      async execute() {
        executed = true;
        return { ok: true };
      },
    };

    const objectResult = await executeTool({
      tool: inputTool,
      input: { nested: { missing: undefined } },
      sessionId,
      turnId,
      toolCallId,
    });
    const arrayResult = await executeTool({
      tool: inputTool,
      input: { nested: ["present", undefined] },
      sessionId,
      turnId,
      toolCallId,
    });

    expect(objectResult).toMatchObject({
      status: "failed",
      error: { code: "tool.input_not_serializable" },
    });
    expect(arrayResult).toMatchObject({
      status: "failed",
      error: { code: "tool.input_not_serializable" },
    });
    expect(executed).toBe(false);
  });

  it("returns a typed failure for cyclic tool input and output", async () => {
    const cyclicInput = { name: "x" } as { name: string; self?: unknown };
    cyclicInput.self = cyclicInput;
    const inputResult = await executeTool({
      tool: {
        ...tool,
        inputSchema: { type: "object" },
        idempotency: { enabled: true },
      },
      input: cyclicInput,
      sessionId,
      turnId,
      toolCallId,
    });
    expect(inputResult).toMatchObject({
      status: "failed",
      error: { code: "tool.input_not_serializable", category: "validation" },
    });

    const outputTool: ToolDefinition<{ name: string }, unknown> = {
      ...tool,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      async execute() {
        const cyclicOutput: Record<string, unknown> = {};
        cyclicOutput.self = cyclicOutput;
        return cyclicOutput;
      },
    };
    const outputResult = await executeTool({
      tool: outputTool,
      input: { name: "x" },
      sessionId,
      turnId,
      toolCallId,
    });
    expect(outputResult).toMatchObject({
      status: "failed",
      error: { code: "tool.output_not_serializable", category: "validation" },
    });
  });

  it("executes a tool and returns a succeeded ToolCall", async () => {
    const call = await executeTool({
      tool,
      input: { name: "T-vic" },
      sessionId,
      turnId,
      toolCallId,
    });

    expect(call).toMatchObject({
      status: "succeeded",
      output: { greeting: "hello T-vic" },
    });
  });

  it("reports an abort-aware tool timeout as timed_out", async () => {
    const timeoutTool: ToolDefinition<Record<string, never>, { ok: boolean }> = {
      ...tool,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      timeout: { timeoutMs: 5, onTimeout: "fail" },
      retry: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0, backoff: "fixed", jitter: false },
      async execute(_input, context) {
        await new Promise<void>((resolve) => {
          const onAbort = (): void => {
            context.signal.removeEventListener("abort", onAbort);
            resolve();
          };
          if (context.signal.aborted) {
            resolve();
          } else {
            context.signal.addEventListener("abort", onAbort, { once: true });
          }
        });
        return { ok: true };
      },
    };

    const call = await executeTool({
      tool: timeoutTool,
      input: {},
      sessionId,
      turnId,
      toolCallId,
    });

    expect(call.status).toBe("timed_out");
    expect(call.status === "timed_out" && call.error.code).toBe("tool.timeout");
  });

  it("fails a tool whose output violates its output schema", async () => {
    const badTool: ToolDefinition<{ name: string }, unknown> = {
      ...tool,
      outputSchema: {
        type: "object",
        required: ["greeting"],
        properties: { greeting: { type: "string" } },
      },
      async execute() {
        return { wrong: true } as never;
      },
    };
    const call = await executeTool({
      tool: badTool,
      input: { name: "x" },
      sessionId,
      turnId,
      toolCallId,
    });
    expect(call.status).toBe("failed");
    expect(call.status === "failed" && call.error.code).toBe("tool.output_validation_failed");
  });

  it("retries a retriable failure up to maxAttempts then succeeds", async () => {
    let calls = 0;
    const flaky: ToolDefinition<Record<string, never>, { ok: boolean }> = {
      ...tool,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      retry: { maxAttempts: 3, initialDelayMs: 0, maxDelayMs: 0, backoff: "fixed", jitter: false },
      async execute() {
        calls += 1;
        if (calls < 3) {
          throw new Error("transient");
        }
        return { ok: true };
      },
    };
    const call = await executeTool({ tool: flaky, input: {}, sessionId, turnId, toolCallId });
    expect(call.status).toBe("succeeded");
    expect(call.attempts).toBe(3);
    expect(calls).toBe(3);
  });

  it("does not re-execute an idempotent tool with a matching key", async () => {
    let calls = 0;
    const idem: ToolDefinition<{ id: number }, { n: number }> = {
      ...tool,
      inputSchema: { type: "object", properties: { id: { type: "number" } } },
      outputSchema: { type: "object" },
      idempotency: { enabled: true, ttlMs: 10_000 },
      async execute(input) {
        calls += 1;
        return { n: input.id };
      },
    };
    const store = new InMemoryToolIdempotencyStore();
    const first = await executeTool({
      tool: idem,
      input: { id: 7 },
      sessionId,
      turnId,
      toolCallId,
      idempotencyStore: store,
    });
    const second = await executeTool({
      tool: idem,
      input: { id: 7 },
      sessionId,
      turnId,
      toolCallId,
      idempotencyStore: store,
    });
    expect(first.status).toBe("succeeded");
    expect(second).toMatchObject({ status: "succeeded", output: { n: 7 } });
    expect(calls).toBe(1);
  });

  it("retains tool identity and version after idempotency completion", async () => {
    const store = new InMemoryToolIdempotencyStore();
    const claim = await store.claim({
      key: "tool_1@0.1.0:stable",
      toolId: tool.id,
      toolVersion: tool.version,
      requestHash: "hash",
      owner: "owner",
      ttlMs: 10_000,
    });
    expect(claim.status).toBe("claimed");
    await store.complete("tool_1@0.1.0:stable", "hash", {
      status: "succeeded",
      output: { greeting: "hello" },
      ttlMs: 10_000,
      owner: "owner",
    });
    await expect(
      store.claim({
        key: "tool_1@0.1.0:stable",
        toolId: tool.id,
        toolVersion: tool.version,
        requestHash: "hash",
        owner: "another-owner",
        ttlMs: 10_000,
      }),
    ).resolves.toMatchObject({
      status: "succeeded",
      record: { toolId: tool.id, toolVersion: tool.version },
    });
  });

  it("requires the matching lease to complete a fenced idempotency claim", async () => {
    let currentLease = {
      sessionId,
      holder: "owner",
      fence: 1,
      expiresAtMs: Date.now() + 10_000,
    };
    const store = new InMemoryToolIdempotencyStore(
      () => Date.now(),
      async (candidate) => (candidate === sessionId ? currentLease : null),
    );
    const lease = { ...currentLease };
    await store.claim({
      key: "fenced_key",
      requestHash: "fenced_hash",
      owner: "tool_owner",
      ttlMs: 10_000,
      lease,
    });
    await expect(
      store.complete("fenced_key", "fenced_hash", {
        status: "succeeded",
        owner: "tool_owner",
        ttlMs: 10_000,
        output: { ok: true },
      }),
    ).rejects.toMatchObject({ code: "LEASE_LOST" });

    currentLease = { ...currentLease, fence: 2 };
    await expect(
      store.complete("fenced_key", "fenced_hash", {
        status: "succeeded",
        owner: "tool_owner",
        ttlMs: 10_000,
        lease: currentLease,
        output: { ok: true },
      }),
    ).rejects.toMatchObject({ code: "LEASE_LOST" });
  });
});
