import { describe, expect, it } from "vitest";

import type { SessionId, ToolCallId, ToolDefinition, ToolId, ToolName, TurnId } from "@tvic/core";

import {
  InMemoryToolIdempotencyStore,
  createToolRegistry,
  executeTool,
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
});
