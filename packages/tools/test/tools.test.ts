import { describe, expect, it, vi } from "vitest";

import { LeaseLostError, providerError } from "@tvic/core";
import type {
  SessionId,
  ToolCallId,
  ToolDefinition,
  ToolIdempotencyLease,
  ToolId,
  SessionLease,
  ToolName,
  TurnId,
  UserId,
} from "@tvic/core";

import {
  InMemoryToolIdempotencyStore,
  createToolRegistry,
  executeTool,
  idempotencyIdentityFor,
  idempotencyKeyFor,
  idempotencyRequestHashFor,
  quarantineRecoveredToolCall,
  stableStringify,
  validateJsonSchemaSubset,
} from "../src/index.js";
import * as publicToolsApi from "../src/index.js";
import { legacyIdempotencyForRecovery } from "../src/idempotency.js";

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

  it("reports cancellation that arrives during retry backoff as cancelled", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      let calls = 0;
      const retrying: ToolDefinition<Record<string, never>, { ok: boolean }> = {
        ...tool,
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        retry: {
          maxAttempts: 3,
          initialDelayMs: 100,
          maxDelayMs: 100,
          backoff: "fixed",
          jitter: false,
        },
        async execute() {
          calls += 1;
          throw providerError("provider.transient", "try again", { retriable: true });
        },
      };

      const resultPromise = executeTool({
        tool: retrying,
        input: {},
        sessionId,
        turnId,
        toolCallId,
        signal: controller.signal,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);

      controller.abort();
      const result = await resultPromise;
      expect(result).toMatchObject({
        status: "cancelled",
        attempts: 1,
        error: { code: "tool.cancelled" },
        metadata: { cancellationPhase: "retry_backoff" },
      });
      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not re-execute an idempotent tool with a matching key", async () => {
    let calls = 0;
    let executorKey: string | undefined;
    const idem: ToolDefinition<{ id: number }, { n: number }> = {
      ...tool,
      inputSchema: { type: "object", properties: { id: { type: "number" } } },
      outputSchema: { type: "object" },
      idempotency: { enabled: true, ttlMs: 10_000 },
      async execute(input, context) {
        calls += 1;
        executorKey = context.idempotencyKey;
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
    expect(first.idempotencyKey).toBe(executorKey);
    expect(second).toMatchObject({ status: "succeeded", output: { n: 7 } });
    expect(calls).toBe(1);
  });

  it("does not execute a second time while the same owner claim is active", async () => {
    let calls = 0;
    let releaseFirst: (() => void) | undefined;
    let markFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const idem: ToolDefinition<{ id: number }, { n: number }> = {
      ...tool,
      inputSchema: { type: "object", properties: { id: { type: "number" } } },
      outputSchema: { type: "object" },
      idempotency: { enabled: true, ttlMs: 10_000 },
      async execute(input) {
        calls += 1;
        if (calls === 1) {
          markFirstStarted?.();
          await firstGate;
        }
        return { n: input.id };
      },
    };
    const store = new InMemoryToolIdempotencyStore();
    const call = {
      tool: idem,
      input: { id: 7 },
      sessionId,
      turnId,
      toolCallId,
      idempotencyStore: store,
    };

    const first = executeTool(call);
    await firstStarted;
    const duplicate = await executeTool(call);
    releaseFirst?.();

    await expect(first).resolves.toMatchObject({ status: "succeeded", output: { n: 7 } });
    expect(duplicate).toMatchObject({
      status: "failed",
      error: { code: "tool.idempotency_in_progress" },
    });
    expect(calls).toBe(1);
  });

  it("executes the input and tenant snapshot used to compute idempotency", async () => {
    let releaseLookup: (() => void) | undefined;
    let markLookupStarted: (() => void) | undefined;
    const lookupStarted = new Promise<void>((resolve) => {
      markLookupStarted = resolve;
    });
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    const seen: Array<{ readonly id: number; readonly userId: string | undefined }> = [];
    const snapshotTool: ToolDefinition<{ id: number }, { ok: boolean }> = {
      ...tool,
      inputSchema: { type: "object", properties: { id: { type: "number" } } },
      outputSchema: { type: "object" },
      idempotency: { enabled: true },
      async execute(input, context) {
        seen.push({ id: input.id, userId: context.tenant?.userId });
        return { ok: true };
      },
    };
    const store = new InMemoryToolIdempotencyStore();
    vi.spyOn(store, "lookup").mockImplementation(async () => {
      markLookupStarted?.();
      await lookupGate;
      return { status: "missing" };
    });
    const mutableInput = { id: 7 };
    const mutableTenant = { userId: "tenant_a" as UserId };

    const result = executeTool({
      tool: snapshotTool,
      input: mutableInput,
      sessionId,
      turnId,
      toolCallId,
      tenant: mutableTenant,
      idempotencyStore: store,
    });
    await lookupStarted;
    mutableInput.id = 9;
    mutableTenant.userId = "tenant_b" as UserId;
    releaseLookup?.();

    await expect(result).resolves.toMatchObject({ status: "succeeded" });
    expect(seen).toEqual([{ id: 7, userId: "tenant_a" }]);
  });

  it("validates and executes one canonical snapshot of accessor-backed input", async () => {
    let reads = 0;
    let seen: boolean | undefined;
    const input = {} as { allowed: boolean };
    Object.defineProperty(input, "allowed", {
      enumerable: true,
      get() {
        reads += 1;
        return reads <= 2 ? false : true;
      },
    });
    const accessorTool: ToolDefinition<{ allowed: boolean }, { ok: boolean }> = {
      ...tool,
      inputSchema: {
        type: "object",
        required: ["allowed"],
        properties: { allowed: { enum: [false] } },
      },
      outputSchema: { type: "object" },
      async execute(value) {
        seen = value.allowed;
        return { ok: true };
      },
    };

    await expect(
      executeTool({ tool: accessorTool, input, sessionId, turnId, toolCallId }),
    ).resolves.toMatchObject({ status: "succeeded" });
    expect(reads).toBe(1);
    expect(seen).toBe(false);
  });

  it("keeps execution and timeout tied to the tool definition captured before async lookup", async () => {
    let releaseExecutor: (() => void) | undefined;
    let originalCalls = 0;
    let replacementCalls = 0;
    let markLookupStarted: (() => void) | undefined;
    const lookupStarted = new Promise<void>((resolve) => {
      markLookupStarted = resolve;
    });
    let releaseLookup: (() => void) | undefined;
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    const mutableTool = {
      ...tool,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      timeout: { timeoutMs: 10, onTimeout: "fail" as const },
      idempotency: { enabled: true },
      async execute() {
        originalCalls += 1;
        await new Promise<void>((resolve) => {
          releaseExecutor = resolve;
        });
        return { greeting: "original" };
      },
    };
    const mutableDefinition = mutableTool as unknown as {
      timeout: { timeoutMs: number; onTimeout: "fail" };
      execute: ToolDefinition["execute"];
    };
    const store = new InMemoryToolIdempotencyStore();
    vi.spyOn(store, "lookup").mockImplementation(async () => {
      markLookupStarted?.();
      await lookupGate;
      return { status: "missing" };
    });

    const result = executeTool({
      tool: mutableTool,
      input: {},
      sessionId,
      turnId,
      toolCallId,
      idempotencyStore: store,
    });
    await lookupStarted;
    mutableDefinition.timeout.timeoutMs = 500;
    mutableDefinition.execute = async () => {
      replacementCalls += 1;
      return { greeting: "replacement" };
    };
    releaseLookup?.();

    await expect(result).resolves.toMatchObject({ status: "timed_out" });
    releaseExecutor?.();
    expect(originalCalls).toBe(1);
    expect(replacementCalls).toBe(0);
  });

  it("detaches cached idempotency output from returned tool results", async () => {
    let calls = 0;
    const outputTool: ToolDefinition<{ id: number }, { nested: { value: number } }> = {
      ...tool,
      inputSchema: { type: "object", properties: { id: { type: "number" } } },
      outputSchema: { type: "object" },
      idempotency: { enabled: true, ttlMs: 10_000 },
      async execute() {
        calls += 1;
        return { nested: { value: 7 } };
      },
    };
    const store = new InMemoryToolIdempotencyStore();
    const call = {
      tool: outputTool,
      input: { id: 1 },
      sessionId,
      turnId,
      toolCallId,
      idempotencyStore: store,
    };

    const first = await executeTool(call);
    if (first.status !== "succeeded") throw new Error("expected the original tool call to succeed");
    (first.output as { nested: { value: number } }).nested.value = 99;
    const replay = await executeTool({ ...call, toolCallId: "tool_call_replay" as ToolCallId });

    expect(replay).toMatchObject({ status: "succeeded", output: { nested: { value: 7 } } });
    expect(calls).toBe(1);
  });

  it("detaches executor output before an asynchronous idempotency write", async () => {
    let markCompletionStarted: (() => void) | undefined;
    const completionStarted = new Promise<void>((resolve) => {
      markCompletionStarted = resolve;
    });
    let releaseCompletion: (() => void) | undefined;
    const completionGate = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    const retainedOutput = { nested: { value: 7 } };
    const outputTool: ToolDefinition<{ id: number }, { nested: { value: number } }> = {
      ...tool,
      inputSchema: { type: "object", properties: { id: { type: "number" } } },
      outputSchema: { type: "object" },
      idempotency: { enabled: true, ttlMs: 10_000 },
      async execute() {
        return retainedOutput;
      },
    };
    const store = new InMemoryToolIdempotencyStore();
    const complete = store.complete.bind(store);
    vi.spyOn(store, "complete").mockImplementation(async (...args) => {
      markCompletionStarted?.();
      await completionGate;
      await complete(...args);
    });

    const result = executeTool({
      tool: outputTool,
      input: { id: 1 },
      sessionId,
      turnId,
      toolCallId,
      idempotencyStore: store,
    });
    await completionStarted;
    retainedOutput.nested.value = 99;
    releaseCompletion?.();

    await expect(result).resolves.toMatchObject({
      status: "succeeded",
      output: { nested: { value: 7 } },
    });
  });

  it("does not quarantine an exact-owner claim in the current lease generation", async () => {
    const lease: ToolIdempotencyLease = {
      sessionId,
      holder: "same_holder",
      fence: 2,
      generationId: "same_generation",
    };
    const recoveryTool: ToolDefinition<{ id: number }, { ok: boolean }> = {
      ...tool,
      inputSchema: { type: "object", properties: { id: { type: "number" } } },
      outputSchema: { type: "object" },
      idempotency: { enabled: true, ttlMs: 10_000 },
      async execute() {
        return { ok: true };
      },
    };
    const store = new InMemoryToolIdempotencyStore(
      () => 100,
      async () => ({ ...lease, expiresAtMs: 10_000 }),
    );
    const recoveryInput = {
      tool: recoveryTool,
      input: { id: 7 },
      sessionId,
      turnId,
      toolCallId,
      idempotencyStore: store,
    };
    const identity = idempotencyIdentityFor(recoveryInput);
    if (!identity) throw new Error("expected an idempotency identity");
    await store.claim({
      key: identity.key,
      requestHash: identity.requestHash,
      sessionId,
      lease,
      toolId: recoveryTool.id,
      toolVersion: recoveryTool.version,
      owner: String(toolCallId),
      ttlMs: 10_000,
    });

    const result = await quarantineRecoveredToolCall(
      recoveryInput,
      lease,
      providerError("tool.runtime_restarted", "interrupted"),
    );

    expect(result).toMatchObject({ status: "in_progress" });
    await expect(
      store.lookup(identity.key, identity.requestHash, sessionId),
    ).resolves.toMatchObject({
      status: "found",
      record: { status: "claimed", owner: String(toolCallId) },
    });
  });

  it("rejects quarantine when an asynchronous lease read is stale", async () => {
    const previousLease: ToolIdempotencyLease = {
      sessionId,
      holder: "old_holder",
      fence: 1,
      generationId: "old_generation",
    };
    const currentLease = {
      sessionId,
      holder: "new_holder",
      fence: 2,
      generationId: "new_generation",
      expiresAtMs: 10_000,
    };
    const store = new InMemoryToolIdempotencyStore(
      () => 100,
      async () => ({ ...previousLease, expiresAtMs: 10_000 }),
      () => currentLease,
    );

    await expect(
      store.quarantine({
        key: "stale-lease-quarantine",
        sessionId,
        lease: previousLease,
        toolId: "tool_1" as ToolId,
        toolVersion: "0.1.0",
        requestHash: "request-hash",
        owner: "tool-call-1",
        ttlMs: 5_000,
        error: providerError("tool.runtime_restarted", "interrupted"),
      }),
    ).rejects.toBeInstanceOf(LeaseLostError);
    await expect(
      store.lookup("stale-lease-quarantine", "request-hash", sessionId),
    ).resolves.toEqual({
      status: "missing",
    });
  });

  it("does not execute again after storing a terminal idempotency failure", async () => {
    let calls = 0;
    const failingTool: ToolDefinition<{ id: number }, { ok: boolean }> = {
      ...tool,
      inputSchema: { type: "object", properties: { id: { type: "number" } } },
      outputSchema: { type: "object" },
      idempotency: { enabled: true, ttlMs: 10_000 },
      async execute() {
        calls += 1;
        throw new Error("external service outcome is unknown");
      },
    };
    const store = new InMemoryToolIdempotencyStore();
    const call = {
      tool: failingTool,
      input: { id: 7 },
      sessionId,
      turnId,
      toolCallId,
      idempotencyStore: store,
    };

    const first = await executeTool(call);
    const retry = await executeTool({ ...call, toolCallId: "tool_call_retry" as ToolCallId });

    expect(first).toMatchObject({ status: "failed" });
    expect(first).toMatchObject({
      error: { code: "tool.execution_failed", message: "Tool execution failed" },
      metadata: { executionAmbiguous: true, recoveryPolicy: "do_not_replay" },
    });
    expect(JSON.stringify(first)).not.toContain("external service outcome is unknown");
    expect(retry).toMatchObject({ status: "failed", metadata: { idempotentHit: true } });
    expect(calls).toBe(1);
  });

  it("returns a non-replayable result when idempotency completion cannot be saved", async () => {
    let calls = 0;
    const successfulTool: ToolDefinition<{ id: number }, { ok: boolean }> = {
      ...tool,
      inputSchema: { type: "object", properties: { id: { type: "number" } } },
      outputSchema: { type: "object" },
      idempotency: { enabled: true, ttlMs: 10_000 },
      async execute() {
        calls += 1;
        return { ok: true };
      },
    };
    const store = new InMemoryToolIdempotencyStore();
    vi.spyOn(store, "complete").mockRejectedValue(new Error("database host and credentials"));
    const call = {
      tool: successfulTool,
      input: { id: 7 },
      sessionId,
      turnId,
      toolCallId,
      idempotencyStore: store,
    };

    const result = await executeTool(call);
    const retry = await executeTool({ ...call, toolCallId: "tool_call_retry" as ToolCallId });

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "tool.idempotency_result_unrecorded" },
      metadata: { executionAmbiguous: true, recoveryPolicy: "do_not_replay" },
    });
    expect(result).not.toHaveProperty("output");
    expect(retry).toMatchObject({ error: { code: "tool.idempotency_in_progress" } });
    expect(calls).toBe(1);
    expect(JSON.stringify(result)).not.toContain("database host and credentials");
  });

  it("stores only fixed-size digests for new idempotency keys and fingerprints", () => {
    const secretInput = "customer-secret-input-7c9a2";
    const sensitiveTool: ToolDefinition<{ name: string }, { greeting: string }> = {
      ...tool,
      idempotency: { enabled: true },
    };
    const input = {
      tool: sensitiveTool,
      input: { name: secretInput },
      sessionId,
      turnId,
      toolCallId,
    };
    const key = idempotencyKeyFor(input);
    const requestHash = idempotencyRequestHashFor(input);
    const identity = idempotencyIdentityFor(input);
    const largeKey = idempotencyKeyFor({ ...input, input: { name: "x".repeat(10_000) } });

    expect(key).not.toContain(secretInput);
    expect(key).toMatch(/^tvic:v3:sha256:[a-f0-9]{64}$/);
    expect(largeKey?.length).toBe(key?.length);
    expect(requestHash).not.toContain(secretInput);
    expect(requestHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(identity).not.toHaveProperty("legacy");
    expect(publicToolsApi).not.toHaveProperty("legacyIdempotencyForRecovery");
  });

  it("keeps the operation key stable across tool versions and rejects changed fingerprints", async () => {
    let calls = 0;
    const versionOne: ToolDefinition<{ name: string }, { greeting: string }> = {
      ...tool,
      version: "1.0.0",
      idempotency: { enabled: true },
      async execute(input) {
        calls += 1;
        return { greeting: `hello ${input.name}` };
      },
    };
    const versionTwo = { ...versionOne, version: "2.0.0" };
    const input = {
      input: { name: "T-vic" },
      sessionId,
      turnId,
      toolCallId,
    };
    const keyV1 = idempotencyKeyFor({ ...input, tool: versionOne });
    const keyV2 = idempotencyKeyFor({ ...input, tool: versionTwo });
    const store = new InMemoryToolIdempotencyStore();

    const first = await executeTool({ ...input, tool: versionOne, idempotencyStore: store });
    const retryAfterUpgrade = await executeTool({
      ...input,
      tool: versionTwo,
      toolCallId: "tool_call_after_upgrade" as ToolCallId,
      idempotencyStore: store,
    });

    expect(keyV2).toBe(keyV1);
    expect(idempotencyRequestHashFor({ ...input, tool: versionTwo })).not.toBe(
      idempotencyRequestHashFor({ ...input, tool: versionOne }),
    );
    expect(first).toMatchObject({ status: "succeeded", output: { greeting: "hello T-vic" } });
    expect(retryAfterUpgrade).toMatchObject({
      status: "failed",
      error: { code: "tool.idempotency_conflict" },
    });
    expect(calls).toBe(1);
  });

  it("allows an explicit key template to scope identity to a tool version", () => {
    const versionOne = {
      ...tool,
      version: "1.0.0",
      idempotency: { enabled: true, keyTemplate: "{toolVersion}:{input}" },
    };
    const versionTwo = { ...versionOne, version: "2.0.0" };
    const input = { input: { name: "T-vic" }, sessionId, turnId, toolCallId };

    expect(idempotencyKeyFor({ ...input, tool: versionOne })).not.toBe(
      idempotencyKeyFor({ ...input, tool: versionTwo }),
    );
  });

  it("skips the migration lookup when legacy key compatibility is disabled", async () => {
    const migrationCompleteTool: ToolDefinition<{ name: string }, { greeting: string }> = {
      ...tool,
      idempotency: { enabled: true, legacyKeyCompatibility: false },
    };
    const store = new InMemoryToolIdempotencyStore();
    const lookup = vi.spyOn(store, "lookup");

    await expect(
      executeTool({
        tool: migrationCompleteTool,
        input: { name: "T-vic" },
        sessionId,
        turnId,
        toolCallId,
        idempotencyStore: store,
      }),
    ).resolves.toMatchObject({ status: "succeeded" });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("keeps an active idempotency claim through the tool timeout and retry budget", async () => {
    const longTool: ToolDefinition<{ id: number }, { n: number }> = {
      ...tool,
      inputSchema: { type: "object", properties: { id: { type: "number" } } },
      outputSchema: { type: "object" },
      timeout: { timeoutMs: 65_000, onTimeout: "fail" },
      retry: {
        maxAttempts: 2,
        initialDelayMs: 10,
        maxDelayMs: 7_000,
        backoff: "fixed",
        jitter: false,
      },
      idempotency: { enabled: true, ttlMs: 1_000 },
      async execute(input) {
        return { n: input.id };
      },
    };
    const store = new InMemoryToolIdempotencyStore();
    const claim = vi.spyOn(store, "claim");

    await executeTool({
      tool: longTool,
      input: { id: 7 },
      sessionId,
      turnId,
      toolCallId,
      idempotencyStore: store,
    });

    expect(claim).toHaveBeenCalledWith(expect.objectContaining({ ttlMs: expect.any(Number) }));
    const claimTtl = claim.mock.calls[0]?.[0].ttlMs;
    expect(claimTtl).toBeGreaterThanOrEqual(65_000 * 2 + 7_000 + 1_000);
  });

  it.each([undefined, "{input}"])(
    "does not replay tenant-specific output across sessions or tenant contexts (key template: %s)",
    async (keyTemplate) => {
      let calls = 0;
      const tenantTool: ToolDefinition<{ id: number }, { userId: string }> = {
        ...tool,
        inputSchema: { type: "object", properties: { id: { type: "number" } } },
        outputSchema: { type: "object" },
        idempotency: {
          enabled: true,
          ttlMs: 10_000,
          ...(keyTemplate !== undefined ? { keyTemplate } : {}),
        },
        async execute(_input, context) {
          calls += 1;
          return { userId: String(context.tenant?.userId) };
        },
      };
      const store = new InMemoryToolIdempotencyStore();
      const first = await executeTool({
        tool: tenantTool,
        input: { id: 7 },
        sessionId: "tenant_a_session" as SessionId,
        turnId,
        toolCallId,
        tenant: { userId: "tenant_a" as UserId },
        idempotencyStore: store,
      });
      const second = await executeTool({
        tool: tenantTool,
        input: { id: 7 },
        sessionId: "tenant_b_session" as SessionId,
        turnId,
        toolCallId: "tool_call_2" as ToolCallId,
        tenant: { userId: "tenant_b" as UserId },
        idempotencyStore: store,
      });
      const sameSessionDifferentTenant = await executeTool({
        tool: tenantTool,
        input: { id: 7 },
        sessionId: "tenant_a_session" as SessionId,
        turnId,
        toolCallId: "tool_call_3" as ToolCallId,
        tenant: { userId: "tenant_b" as UserId },
        idempotencyStore: store,
      });

      expect(first).toMatchObject({ status: "succeeded", output: { userId: "tenant_a" } });
      expect(second).toMatchObject({ status: "succeeded", output: { userId: "tenant_b" } });
      expect(sameSessionDifferentTenant).toMatchObject({
        status: "failed",
        error: { code: "tool.idempotency_conflict" },
      });
      expect(calls).toBe(2);
    },
  );

  it("fails closed on legacy successes with or without current tenant context", async () => {
    const sessionA = "legacy_idempotency_a" as SessionId;
    const sessionB = "legacy_idempotency_b" as SessionId;
    const leaseA = {
      sessionId: sessionA,
      holder: "legacy_a",
      fence: 1,
      generationId: "legacy_gen_a",
      expiresAtMs: 10_000,
    };
    const leaseB = {
      sessionId: sessionB,
      holder: "legacy_b",
      fence: 1,
      generationId: "legacy_gen_b",
      expiresAtMs: 10_000,
    };
    const leases = new Map([
      [sessionA, leaseA],
      [sessionB, leaseB],
    ]);
    const store = new InMemoryToolIdempotencyStore(
      () => 100,
      async (candidate) => leases.get(candidate) ?? null,
    );
    let calls = 0;
    const legacyTool: ToolDefinition<{ id: number }, { userId: string }> = {
      ...tool,
      inputSchema: { type: "object", properties: { id: { type: "number" } } },
      outputSchema: { type: "object" },
      idempotency: { enabled: true, keyTemplate: "{input}", ttlMs: 10_000 },
      async execute(_input, context) {
        calls += 1;
        return { userId: String(context.tenant?.userId) };
      },
    };
    const inputA = {
      tool: legacyTool,
      input: { id: 7 },
      sessionId: sessionA,
      turnId,
      toolCallId,
      tenant: { userId: "tenant_a" as UserId },
      lease: leaseA,
      idempotencyStore: store,
    };
    const legacy = legacyIdempotencyForRecovery(inputA);
    if (!legacy) throw new Error("expected a legacy idempotency key");
    await store.claim({
      key: legacy.key,
      requestHash: legacy.requestHash,
      owner: "old_tool_call",
      ttlMs: 10_000,
      lease: leaseA,
      toolId: legacyTool.id,
      toolVersion: legacyTool.version,
    });
    await store.complete(legacy.key, legacy.requestHash, {
      status: "succeeded",
      owner: "old_tool_call",
      output: { userId: "tenant_a" },
      ttlMs: 10_000,
      lease: leaseA,
    });

    const sameSessionInput = {
      tool: inputA.tool,
      input: inputA.input,
      sessionId: inputA.sessionId,
      turnId: inputA.turnId,
      toolCallId: inputA.toolCallId,
      lease: inputA.lease,
      idempotencyStore: inputA.idempotencyStore,
    };
    const sameSession = await executeTool(sameSessionInput);
    const changedTenant = await executeTool({
      ...inputA,
      toolCallId: "legacy_tool_call_changed_tenant" as ToolCallId,
      tenant: { userId: "tenant_b" as UserId },
    });
    const otherSession = await executeTool({
      ...inputA,
      sessionId: sessionB,
      toolCallId: "legacy_tool_call_b" as ToolCallId,
      tenant: { userId: "tenant_b" as UserId },
      lease: leaseB,
    });
    expect(sameSession).toMatchObject({
      status: "failed",
      error: { code: "tool.idempotency_conflict" },
    });
    expect(sameSession).not.toHaveProperty("output");
    expect(changedTenant).toMatchObject({
      status: "failed",
      error: { code: "tool.idempotency_conflict" },
    });
    expect(changedTenant).not.toHaveProperty("output");
    expect(otherSession).toMatchObject({
      status: "failed",
      error: { code: "tool.idempotency_conflict" },
    });
    expect(otherSession).not.toHaveProperty("output");
    expect(calls).toBe(0);
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
      generationId: "generation_1",
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

    currentLease = { ...currentLease, fence: 2, generationId: "generation_2" };
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

  it("does not replay or expose a result to a different lease session", async () => {
    const sessionA = "idempotency_session_a" as SessionId;
    const sessionB = "idempotency_session_b" as SessionId;
    const leases = new Map<SessionId, SessionLease>([
      [
        sessionA,
        {
          sessionId: sessionA,
          holder: "holder_a",
          fence: 1,
          generationId: "generation_a",
          acquiredAtMs: 0,
          renewedAtMs: 0,
          expiresAtMs: 10_000,
        },
      ],
      [
        sessionB,
        {
          sessionId: sessionB,
          holder: "holder_b",
          fence: 1,
          generationId: "generation_b",
          acquiredAtMs: 0,
          renewedAtMs: 0,
          expiresAtMs: 10_000,
        },
      ],
    ]);
    const store = new InMemoryToolIdempotencyStore(
      () => 100,
      async (candidate) => leases.get(candidate) ?? null,
    );
    const leaseA = leases.get(sessionA)!;
    const leaseB = leases.get(sessionB)!;
    await store.claim({
      key: "shared-key",
      requestHash: "same-hash",
      owner: "owner_a",
      ttlMs: 1_000,
      lease: leaseA,
    });
    await store.complete("shared-key", "same-hash", {
      status: "succeeded",
      owner: "owner_a",
      output: { tenant: "A" },
      ttlMs: 1_000,
      lease: leaseA,
    });
    await expect(
      store.complete("shared-key", "same-hash", {
        status: "succeeded",
        owner: "owner_a",
        output: { tenant: "B" },
        ttlMs: 1_000,
        lease: leaseB,
      }),
    ).rejects.toMatchObject({ code: "LEASE_LOST" });

    const crossSession = await store.claim({
      key: "shared-key",
      requestHash: "same-hash",
      owner: "owner_b",
      ttlMs: 1_000,
      lease: leaseB,
    });
    expect(crossSession).toMatchObject({ status: "conflict" });
    await store.claim({
      key: "failed-key",
      requestHash: "failed-hash",
      owner: "owner_a",
      ttlMs: 1_000,
      lease: leaseA,
    });
    await store.complete("failed-key", "failed-hash", {
      status: "failed",
      owner: "owner_a",
      error: providerError("private.failure", "private detail"),
      ttlMs: 1_000,
      lease: leaseA,
    });
    const crossSessionFailure = await store.claim({
      key: "failed-key",
      requestHash: "failed-hash",
      owner: "owner_b",
      ttlMs: 1_000,
      lease: leaseB,
    });
    expect(crossSessionFailure.status).toBe("conflict");
    await expect(store.lookup("shared-key", "different-hash", sessionA)).resolves.toEqual({
      status: "conflict",
    });
    await expect(store.lookup("shared-key", "same-hash", sessionB)).resolves.toEqual({
      status: "conflict",
    });
    await expect(
      store.claim({ key: "shared-key", requestHash: "same-hash", owner: "unfenced", ttlMs: 1_000 }),
    ).resolves.toEqual({ status: "conflict" });
  });
});
