import type { DurableOutboxEvent, SessionId, ToolCallId, TurnId } from "@tvic/core";

export function prefix(value: string | undefined): string {
  return value ?? "tvic:v1:";
}

export function sessionKey(value: string | undefined, id: SessionId): string {
  return `${prefix(value)}session:${encodeKeyPart(id)}`;
}

export function turnKey(value: string | undefined, sessionId: SessionId, id: TurnId): string {
  return `${prefix(value)}turn:${encodeKeyPart(sessionId)}:${encodeKeyPart(id)}`;
}

export function toolCallKey(
  value: string | undefined,
  sessionId: SessionId,
  id: ToolCallId,
): string {
  return `${prefix(value)}tool_call:${encodeKeyPart(sessionId)}:${encodeKeyPart(id)}`;
}

export function leaseKey(value: string | undefined, sessionId: SessionId): string {
  return `${prefix(value)}lease:${encodeKeyPart(sessionId)}`;
}

export function idempotencyKey(value: string | undefined, key: string): string {
  return `${prefix(value)}idempotency:${encodeKeyPart(key)}`;
}

export function outboxKey(value: string | undefined, id: string): string {
  return `${prefix(value)}outbox:${encodeKeyPart(id)}`;
}

export function sessionIndexKey(value: string | undefined): string {
  return `${prefix(value)}sessions`;
}

export function turnIndexKey(value: string | undefined, sessionId: SessionId): string {
  return `${prefix(value)}session:${encodeKeyPart(sessionId)}:turns`;
}

export function toolIndexKey(value: string | undefined, sessionId: SessionId): string {
  return `${prefix(value)}session:${encodeKeyPart(sessionId)}:tools`;
}

export function leaseIndexKey(value: string | undefined): string {
  return `${prefix(value)}leases`;
}

export function cacheEventKey(value: string | undefined, event: DurableOutboxEvent): string {
  if (event.aggregateType === "session") return sessionKey(value, event.aggregateId as SessionId);
  if (event.aggregateType === "turn") {
    return turnKey(value, event.sessionId, event.aggregateId as TurnId);
  }
  return toolCallKey(value, event.sessionId, event.aggregateId as ToolCallId);
}

export function cacheEventIndexKey(value: string | undefined, event: DurableOutboxEvent): string {
  if (event.aggregateType === "session") return sessionIndexKey(value);
  if (event.aggregateType === "turn") return turnIndexKey(value, event.sessionId);
  return toolIndexKey(value, event.sessionId);
}

export function cacheEventScore(
  type: DurableOutboxEvent["aggregateType"],
  payload: unknown,
): number {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return 0;
  const value = payload as Record<string, unknown>;
  if (type === "turn" && typeof value.sequence === "number") return value.sequence;
  const timestamp = type === "session" ? value.createdAt : value.queuedAt;
  const parsed = typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function encodeKeyPart(value: string): string {
  return encodeURIComponent(value);
}

export function decodeKeyPart(value: string): string {
  return decodeURIComponent(value);
}
