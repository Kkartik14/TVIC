/**
 * Shared agent + LLM summarizer for the post-call-summarization example.
 * The default summarizer is deterministic so the example runs without API
 * keys. Replace it with a function that calls your provider and returns a
 * structured result when wiring production.
 */
import { defineAgent, type SessionEndEvent } from "@tvic/runtime";
import { PCM16_16K_MONO, type ProviderCapabilities } from "@tvic/core";

const TEST_PROVIDER_CAPABILITIES = {
  streaming: { input: true, output: true, native: true },
  cancellation: { request: true, output: true, buffer: true, truncation: true },
  transports: ["websocket" as const],
  audio: { input: [PCM16_16K_MONO], output: [PCM16_16K_MONO] },
  tools: { functionCalling: true, parallelCalls: true },
  playout: { clearBuffer: true, acknowledgement: true, position: true },
} satisfies ProviderCapabilities;

export interface SummarizationResult {
  readonly summary: string;
  readonly facts: readonly string[];
}

/**
 * Offline summarizer. Produces a deterministic summary from the call id so
 * the demo is runnable without an LLM API key. A production application can
 * replace this function with its own provider call.
 */
export function buildDeterministicSummarizer() {
  return async (event: SessionEndEvent): Promise<SummarizationResult> => {
    return {
      summary:
        `session ${event.session.id} ended at ${event.wallClockMs}; ` +
        `${event.snapshot.turns.length} turns, ${event.snapshot.toolCalls.length} tool calls, ` +
        `${event.finalMemorySnapshot.user?.size ?? 0} user facts on file.`,
      facts: [`sessionId=${event.session.id}`, `turnCount=${event.snapshot.turns.length}`],
    };
  };
}

export function buildAgent() {
  return defineAgent({
    id: "post-call-summarization-agent",
    name: "Post-Call Summarization Agent",
    instructions:
      "You are a customer service agent. After each call, a post-call summarizer writes a summary to memory for the next call.",
    tools: [],
    audioPolicy: { input: PCM16_16K_MONO, output: PCM16_16K_MONO },
    memoryPolicy: {
      enabled: true,
      scopes: ["user", "session"],
      preCallLoad: "all",
    },
    providers: {
      telephony: {
        name: "demo-telephony",
        kind: "telephony",
        version: "0.1.0",
        capabilities: TEST_PROVIDER_CAPABILITIES,
        accept: async () => undefined as never,
        hangup: async () => undefined,
      } as never,
      stt: {
        name: "demo-stt",
        kind: "stt",
        version: "0.1.0",
        capabilities: TEST_PROVIDER_CAPABILITIES,
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
          transports: ["websocket"],
          audio: { input: [PCM16_16K_MONO], output: [PCM16_16K_MONO] },
          tools: { functionCalling: true, parallelCalls: true },
          playout: { clearBuffer: true, acknowledgement: true, position: false },
        },
        complete: async (): Promise<{ text: string }> => ({ text: "Hello." }),
      } as never,
    },
    interruptionPolicy: { mode: "allow" as const, minSpeechMs: 250, trimOutputOnInterrupt: false },
    timeoutPolicy: { timeoutMs: 30_000, onTimeout: "fail" },
  });
}
