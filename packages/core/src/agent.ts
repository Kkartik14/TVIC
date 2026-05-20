import type { AudioFormat } from "./audio.js";
import type { AgentId } from "./ids.js";
import type { MemoryScope } from "./memory.js";
import type {
  FallbackPolicy,
  InterruptionPolicy,
  RetryPolicy,
  TimeoutPolicy,
} from "./policies.js";
import type {
  LLMProvider,
  RealtimeModelProvider,
  SpeechToTextProvider,
  TelephonyProvider,
  TextToSpeechProvider,
  TraceExporter,
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
  readonly resampleAtEdge: boolean;
}

export type AgentRuntimeMode = "realtime" | "pipeline";

export interface AgentRealtimeProviders {
  readonly mode: "realtime";
  readonly telephony: TelephonyProvider;
  readonly realtimeModel: RealtimeModelProvider;
  readonly traceExporters?: readonly TraceExporter[];
}

export interface AgentPipelineProviders {
  readonly mode: "pipeline";
  readonly telephony: TelephonyProvider;
  readonly stt: SpeechToTextProvider;
  readonly llm: LLMProvider;
  readonly tts: TextToSpeechProvider;
  readonly traceExporters?: readonly TraceExporter[];
}

export type AgentProviders = AgentRealtimeProviders | AgentPipelineProviders;

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
  readonly timeoutPolicy: TimeoutPolicy;
  readonly retryPolicy: RetryPolicy;
  readonly fallbackPolicy?: FallbackPolicy;
  readonly metadata?: Readonly<Record<string, unknown>>;
}
