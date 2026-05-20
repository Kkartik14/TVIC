import type { AudioFormat } from "./audio.js";
import type { StreamEndReason } from "./media.js";

export type ProviderKind =
  | "telephony"
  | "stt"
  | "tts"
  | "realtime_model"
  | "llm"
  | "storage"
  | "trace_exporter";

export interface ProviderCapabilities {
  readonly streaming: boolean;
  readonly interruption: boolean;
  readonly languages?: readonly string[];
  readonly audioFormats?: readonly AudioFormat[];
  readonly models?: readonly string[];
  readonly voices?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface Provider {
  readonly name: string;
  readonly kind: ProviderKind;
  readonly version: string;
  readonly capabilities: ProviderCapabilities;
  readonly region?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ProviderHealth {
  readonly healthy: boolean;
  readonly latencyMs?: number;
  readonly checkedAt: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface CloseableStream {
  close(reason?: StreamEndReason): Promise<void>;
}
