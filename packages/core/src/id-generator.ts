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
  SpanId,
  CorrelationId,
} from "./ids.js";

export interface CounterIdGenerator<TId extends string = string> {
  next(): TId;
}

export interface IdGenerator {
  agent(): AgentId;
  session(): SessionId;
  call(): CallId;
  turn(): TurnId;
  tool(): ToolId;
  toolCall(): ToolCallId;
  trace(): TraceId;
  traceEvent(): TraceEventId;
  span(): SpanId;
  correlation(): CorrelationId;
  mediaEvent(): MediaEventId;
  memoryEntry(): MemoryEntryId;
  payloadRef(): PayloadRef;
}

export function counterIdGenerator<TId extends string = string>(
  prefix: string,
): CounterIdGenerator<TId> {
  let next = 1;
  return {
    next(): TId {
      const id = `${prefix}_${next}`;
      next += 1;
      return id as TId;
    },
  };
}

export function createDefaultIdGenerator(): IdGenerator {
  return {
    agent: scopedCounter<AgentId>("agent"),
    session: scopedCounter<SessionId>("session"),
    call: scopedCounter<CallId>("call"),
    turn: scopedCounter<TurnId>("turn"),
    tool: scopedCounter<ToolId>("tool"),
    toolCall: scopedCounter<ToolCallId>("tool_call"),
    trace: scopedCounter<TraceId>("trace"),
    traceEvent: scopedCounter<TraceEventId>("trace_event"),
    span: scopedCounter<SpanId>("span"),
    correlation: scopedCounter<CorrelationId>("correlation"),
    mediaEvent: scopedCounter<MediaEventId>("media_event"),
    memoryEntry: scopedCounter<MemoryEntryId>("memory_entry"),
    payloadRef: scopedCounter<PayloadRef>("payload"),
  };
}

function scopedCounter<TId extends string>(prefix: string): () => TId {
  const counter = counterIdGenerator<TId>(prefix);
  return () => counter.next();
}
