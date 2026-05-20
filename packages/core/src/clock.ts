import type { Timestamp } from "./timestamp.js";

export interface Clock {
  now(): Timestamp;
  monotonicMs(): number;
}
