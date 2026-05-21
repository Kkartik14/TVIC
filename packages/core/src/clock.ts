import type { Timestamp } from "./timestamp.js";
import { nowTimestamp } from "./timestamp.js";

export interface Clock {
  now(): Timestamp;
  monotonicMs(): number;
}

export function monotonicOffsetMs(clock: Clock, startedAtMs: number): number {
  return Math.max(0, clock.monotonicMs() - startedAtMs);
}

export function createSystemClock(): Clock {
  const startedAt = performance.now();
  return {
    now(): Timestamp {
      return nowTimestamp();
    },
    monotonicMs(): number {
      return performance.now() - startedAt;
    },
  };
}
