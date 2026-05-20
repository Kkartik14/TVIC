import type { AudioFormat } from "../audio.js";
import type { NormalizedError } from "../errors.js";
import type { ProviderEventId, SessionId, ToolName, TraceId, TurnId } from "../ids.js";
import type { InputAudioChunk, OutputAudioChunk } from "../media.js";
import type { Provider } from "../provider.js";
import type { Timestamp } from "../timestamp.js";
import type { ToolDefinition } from "../tool.js";
import type { TranscriptEvent } from "./transcript.js";

export interface RealtimeOpenRequest {
  readonly sessionId: SessionId;
  readonly model: string;
  readonly instructions: string;
  readonly tools?: readonly ToolDefinition[];
  readonly inputFormat: AudioFormat;
  readonly outputFormat: AudioFormat;
  readonly voice?: string;
  readonly temperature?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface RealtimeEventBase {
  readonly id: ProviderEventId;
  readonly sessionId: SessionId;
  readonly turnId?: TurnId;
  readonly traceId?: TraceId;
  readonly sequence: number;
  readonly provider: string;
  readonly timestamp: Timestamp;
}

export type RealtimeTextEvent =
  | (RealtimeEventBase & {
      readonly type: "realtime.text.delta";
      readonly text: string;
    })
  | (RealtimeEventBase & {
      readonly type: "realtime.text.completed";
      readonly text: string;
    });

export interface RealtimeToolCallEvent extends RealtimeEventBase {
  readonly type: "realtime.tool_call";
  readonly turnId: TurnId;
  readonly callRef: string;
  readonly toolName: ToolName;
  readonly input: unknown;
}

export interface RealtimeOutputCancelledEvent extends RealtimeEventBase {
  readonly type: "realtime.output.cancelled";
  readonly turnId: TurnId;
  readonly reason: "barge_in" | "user_request" | "timeout";
}

export interface RealtimeAudioInputEvent extends RealtimeEventBase {
  readonly type: "realtime.audio.input";
  readonly chunk: InputAudioChunk;
}

export interface RealtimeAudioOutputEvent extends RealtimeEventBase {
  readonly type: "realtime.audio.output";
  readonly chunk: OutputAudioChunk;
}

export interface RealtimeErrorEvent extends RealtimeEventBase {
  readonly type: "realtime.error";
  readonly error: NormalizedError;
}

export type RealtimeEvent =
  | RealtimeAudioInputEvent
  | RealtimeAudioOutputEvent
  | TranscriptEvent
  | RealtimeTextEvent
  | RealtimeToolCallEvent
  | RealtimeOutputCancelledEvent
  | RealtimeErrorEvent;

export interface RealtimeSession {
  readonly events: AsyncIterable<RealtimeEvent>;
  sendAudio(chunk: InputAudioChunk): Promise<void>;
  sendText(text: string): Promise<void>;
  sendToolResult(callRef: string, output: unknown, error?: NormalizedError): Promise<void>;
  commitInput(): Promise<void>;
  cancelOutput(): Promise<void>;
  close(): Promise<void>;
}

export interface RealtimeModelProvider extends Provider {
  readonly kind: "realtime_model";
  open(request: RealtimeOpenRequest): Promise<RealtimeSession>;
}
