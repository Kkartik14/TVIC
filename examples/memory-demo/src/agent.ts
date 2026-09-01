/**
 * The agent used by all three memory-demo sub-demos. Demonstrates the
 * cross-call memory contract: a customer service agent that learns the
 * caller's name and account number on the first call, then greets them by
 * name on subsequent calls.
 */
import { defineAgent } from "@tvic/runtime";
import {
  PCM16_16K_MONO,
  type InterruptionMode,
  type LLMProvider,
  type SpeechToTextProvider,
  type TelephonyProvider,
} from "@tvic/core";

/**
 * Demo providers that satisfy `evaluateProviderCompatibility` and pass the
 * agent's required-provider set. The sub-demos never invoke `runtime.start`
 * with this agent on a real call — they only assert the pre-call memory
 * block, which is constructed before the pipeline runs. Real provider
 * wiring is the per-demo sub-demo's job, not the shared agent's.
 */
const TEST_PROVIDER_CAPABILITIES = {
  streaming: { input: true, output: true, native: true },
  cancellation: { request: true, output: true, buffer: true, truncation: true },
  transports: ["websocket" as const],
  audio: { input: [PCM16_16K_MONO], output: [PCM16_16K_MONO] },
  tools: { functionCalling: true, parallelCalls: true },
  playout: { clearBuffer: true, acknowledgement: true, position: true },
};

const demoTelephony: TelephonyProvider = {
  name: "memory-demo-telephony",
  kind: "telephony",
  version: "0.1.0",
  capabilities: TEST_PROVIDER_CAPABILITIES,
  async dial() {
    throw new Error("memory-demo: telephony not used in this demo");
  },
  async accept() {
    throw new Error("memory-demo: telephony not used in this demo");
  },
  async hangup() {
    return;
  },
};

const demoStt: SpeechToTextProvider = {
  name: "memory-demo-stt",
  kind: "stt",
  version: "0.1.0",
  capabilities: TEST_PROVIDER_CAPABILITIES,
  async open() {
    throw new Error("memory-demo: stt not used in this demo");
  },
};

const demoLlm: LLMProvider = {
  name: "memory-demo-llm",
  kind: "llm",
  version: "0.1.0",
  capabilities: TEST_PROVIDER_CAPABILITIES,
  async complete() {
    throw new Error("memory-demo: llm not used in this demo");
  },
};

export function buildMemoryDemoAgent() {
  return defineAgent({
    id: "memory-demo-agent",
    name: "Memory Demo Agent",
    instructions: [
      "You are a helpful customer service agent.",
      "When the caller shares information (name, account number, preferences),",
      "use the `remember_fact` tool to persist it to memory.",
      "On subsequent calls, the runtime pre-loads prior memory into your",
      "context — greet the caller by name and recall what they shared before.",
    ].join(" "),
    tools: [],
    audioPolicy: { input: PCM16_16K_MONO, output: PCM16_16K_MONO },
    memoryPolicy: {
      enabled: true,
      scopes: ["user", "session"],
      canLlmWrite: true,
      preCallLoad: "all",
    },
    providers: {
      telephony: demoTelephony,
      stt: demoStt,
      llm: demoLlm,
    },
    interruptionPolicy: {
      mode: "allow" as InterruptionMode,
      minSpeechMs: 250,
      trimOutputOnInterrupt: false,
    },
    timeoutPolicy: { timeoutMs: 30_000, onTimeout: "fail" },
  });
}
