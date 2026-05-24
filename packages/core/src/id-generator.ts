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
  // Each generator instance gets a crypto-strong namespace so ids from different
  // generators (e.g. the runtime and the pipeline loop) are globally unique within one
  // trace stream — otherwise their `span_1`, `span_2`, … would collide and the span
  // waterfall would merge unrelated spans. Inject a deterministic generator in tests.
  const namespace = globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  return {
    agent: scopedCounter<AgentId>("agent", namespace),
    session: scopedCounter<SessionId>("session", namespace),
    call: scopedCounter<CallId>("call", namespace),
    turn: scopedCounter<TurnId>("turn", namespace),
    tool: scopedCounter<ToolId>("tool", namespace),
    toolCall: scopedCounter<ToolCallId>("tool_call", namespace),
    trace: scopedCounter<TraceId>("trace", namespace),
    traceEvent: scopedCounter<TraceEventId>("trace_event", namespace),
    span: scopedCounter<SpanId>("span", namespace),
    correlation: scopedCounter<CorrelationId>("correlation", namespace),
    mediaEvent: scopedCounter<MediaEventId>("media_event", namespace),
    memoryEntry: scopedCounter<MemoryEntryId>("memory_entry", namespace),
    payloadRef: scopedCounter<PayloadRef>("payload", namespace),
  };
}

function scopedCounter<TId extends string>(prefix: string, namespace?: string): () => TId {
  const counter = counterIdGenerator<TId>(namespace ? `${prefix}_${namespace}` : prefix);
  return () => counter.next();
}
