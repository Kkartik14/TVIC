import type { Brand } from "./branded.js";

export type Timestamp = Brand<string, "Timestamp">;

export type DurationMs = Brand<number, "DurationMs">;

export type LatencyMs = Brand<number, "LatencyMs">;
