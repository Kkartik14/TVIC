import type {
  AgentId,
  CallId,
  MediaEventId,
  MemoryEntryId,
  PayloadRef,
  SessionId,
  ToolCallId,
  ToolId,
  TraceEventId,
  TraceId,
  TurnId,
} from "./ids.js";

export interface IdGenerator {
  agent(): AgentId;
  session(): SessionId;
  call(): CallId;
  turn(): TurnId;
  tool(): ToolId;
  toolCall(): ToolCallId;
  trace(): TraceId;
  traceEvent(): TraceEventId;
  mediaEvent(): MediaEventId;
  memoryEntry(): MemoryEntryId;
  payloadRef(): PayloadRef;
}
