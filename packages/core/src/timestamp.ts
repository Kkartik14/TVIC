import type { Brand } from "./branded.js";

export type Timestamp = Brand<string, "Timestamp">;

export type DurationMs = Brand<number, "DurationMs">;

export type LatencyMs = Brand<number, "LatencyMs">;

export function toTimestamp(date: Date): Timestamp {
  return date.toISOString() as Timestamp;
}

export function nowTimestamp(): Timestamp {
  return toTimestamp(new Date());
}
