import type { AudioFormat } from "./audio.js";
import type { AgentId } from "./ids.js";
import type { MemoryScope } from "./memory.js";
import type { InterruptionPolicy, TimeoutPolicy } from "./policies.js";
import type {
  LLMProvider,
  SpeechToTextProvider,
  TelephonyProvider,
  TextToSpeechProvider,
} from "./providers/index.js";
import type { ToolDefinition } from "./tool.js";

export interface AgentMemoryPolicy {
  readonly enabled: boolean;
  readonly scopes: readonly MemoryScope[];
  readonly maxBytesPerSession?: number;
  readonly readOnly?: boolean;
}

export interface AgentAudioPolicy {
  readonly input: AudioFormat;
  readonly output: AudioFormat;
}

export interface AgentProviders {
  readonly telephony: TelephonyProvider;
  readonly stt: SpeechToTextProvider;
  readonly llm: LLMProvider;
  readonly tts: TextToSpeechProvider;
}

export interface Agent {
  readonly id: AgentId;
  readonly name: string;
  readonly version: string;
  readonly instructions: string;
  readonly tools: readonly ToolDefinition[];
  readonly providers: AgentProviders;
  readonly audioPolicy: AgentAudioPolicy;
  readonly memoryPolicy: AgentMemoryPolicy;
  readonly interruptionPolicy: InterruptionPolicy;
  /** Per-operation timeout for provider streams (wired into the loop's stall guard). */
  readonly timeoutPolicy: TimeoutPolicy;
  readonly metadata?: Readonly<Record<string, unknown>>;
}
