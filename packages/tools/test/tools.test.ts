import { describe, expect, it } from "vitest";

import type {
  SessionId,
  ToolCallId,
  ToolDefinition,
  ToolId,
  ToolName,
  TurnId,
} from "@tvic/core";

import { createToolRegistry, executeTool, validateJsonSchema } from "../src/index.js";

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
    const registry = createToolRegistry([tool]);
    expect(registry.get(tool.id)).toBe(tool);
  });

  it("validates object schemas", () => {
    expect(validateJsonSchema({}, tool.inputSchema)).toMatchObject({
      valid: false,
      errors: ["$.name is required"],
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
});
