import { defineAgent } from "@tvic/runtime";
import { PCM16_16K_MONO, type Agent } from "@tvic/core";
import { describe, expect, it } from "vitest";

function buildAgent(): Agent {
  return defineAgent({
    id: "persona-demo-agent",
    name: "Persona Demo Agent",
    instructions:
      "You are a customer service agent. Use the persona config to inject per-tenant context.",
    tools: [],
    audioPolicy: { input: PCM16_16K_MONO, output: PCM16_16K_MONO },
    memoryPolicy: {
      enabled: true,
      scopes: ["user", "session"],
      canLlmWrite: true,
      preCallLoad: "all",
    },
    providers: {
      telephony: {
        name: "demo-telephony",
        kind: "telephony",
        version: "0.1.0",
        capabilities: {
          streaming: { input: true, output: true, native: true },
          cancellation: { request: true, output: true, buffer: true, truncation: true },
          transports: ["websocket" as const],
          audio: { input: [PCM16_16K_MONO], output: [PCM16_16K_MONO] },
          tools: { functionCalling: true, parallelCalls: true },
          playout: { clearBuffer: true, acknowledgement: true, position: true },
        },
        accept: async () => undefined as never,
        hangup: async () => undefined,
      } as never,
      stt: {
        name: "demo-stt",
        kind: "stt",
        version: "0.1.0",
        capabilities: {
          streaming: { input: true, output: true, native: true },
          cancellation: { request: true, output: true, buffer: true, truncation: true },
          transports: ["websocket" as const],
          audio: { input: [PCM16_16K_MONO], output: [PCM16_16K_MONO] },
          tools: { functionCalling: true, parallelCalls: true },
          playout: { clearBuffer: true, acknowledgement: true, position: true },
        },
        open: async () => {
          async function* empty() {}
          return { events: empty(), close: async () => undefined };
        },
      } as never,
      llm: {
        name: "demo-llm",
        kind: "llm",
        version: "0.1.0",
        capabilities: {
          streaming: { input: true, output: true, native: true },
          cancellation: { request: true, output: true, buffer: true, truncation: true },
          transports: ["websocket" as const],
          audio: { input: [PCM16_16K_MONO], output: [PCM16_16K_MONO] },
          tools: { functionCalling: true, parallelCalls: true },
          playout: { clearBuffer: true, acknowledgement: true, position: true },
        },
        complete: (() =>
          Promise.resolve({
            text: "Hello.",
            finishReason: "stop" as const,
          })) as never,
      } as never,
    },
    interruptionPolicy: { mode: "allow" as const, minSpeechMs: 250, trimOutputOnInterrupt: false },
    timeoutPolicy: { timeoutMs: 30_000, onTimeout: "fail" },
    persona: {
      resolveTenantContext: async (_input) => ({
        instructionsOverride: "Test instructions override.",
      }),
    },
  });
}

describe("persona example", () => {
  it("the shared agent carries the persona config", () => {
    const agent = buildAgent();
    expect(agent.persona).toBeDefined();
    expect(agent.persona?.resolveTenantContext).toBeTypeOf("function");
  });

  it("the agent declares user + session scopes in memoryPolicy", () => {
    const agent = buildAgent();
    expect(agent.memoryPolicy.enabled).toBe(true);
    expect(agent.memoryPolicy.scopes).toContain("user");
    expect(agent.memoryPolicy.scopes).toContain("session");
    expect(agent.memoryPolicy.canLlmWrite).toBe(true);
  });
});
