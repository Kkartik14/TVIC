import type {
  AgentId,
  CallId,
  MediaEventId,
  MemoryEntryId,
  SessionId,
  ToolCallId,
  ToolId,
  TurnId,
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
  mediaEvent(): MediaEventId;
  memoryEntry(): MemoryEntryId;
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
  // Each generator instance gets a crypto-strong namespace so ids created by
  // independent runtime modules never collide. Inject a deterministic generator in tests.
  const namespace = globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  return {
    agent: scopedCounter<AgentId>("agent", namespace),
    session: scopedCounter<SessionId>("session", namespace),
    call: scopedCounter<CallId>("call", namespace),
    turn: scopedCounter<TurnId>("turn", namespace),
    tool: scopedCounter<ToolId>("tool", namespace),
    toolCall: scopedCounter<ToolCallId>("tool_call", namespace),
    mediaEvent: scopedCounter<MediaEventId>("media_event", namespace),
    memoryEntry: scopedCounter<MemoryEntryId>("memory_entry", namespace),
  };
}

function scopedCounter<TId extends string>(prefix: string, namespace?: string): () => TId {
  const counter = counterIdGenerator<TId>(namespace ? `${prefix}_${namespace}` : prefix);
  return () => counter.next();
}
