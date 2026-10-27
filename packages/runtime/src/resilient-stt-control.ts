import type { NormalizedError, SttStream } from "@tvic/core";

import type { SttCommandController } from "./stt-command-controller.js";

export type SttRecoveryState =
  | "healthy"
  | "recovering"
  | "opening"
  | "probationary"
  | "failed"
  | "closed";

export interface SttRecoveryControl {
  readonly controller: SttCommandController;
  readonly state: () => SttRecoveryState;
  subscribe(listener: (state: SttRecoveryState) => void): () => void;
  /**
   * Observes context replay failures. Replay-only notifications are suppressed
   * after graceful close begins; caller-submitted update promises still settle.
   */
  subscribeContextUpdateError?(listener: (error: NormalizedError) => void): () => void;
}

export const STT_RECOVERY_CONTROL = Symbol("tvic.stt.recovery-control");

interface RecoveryBrandedStream extends SttStream {
  readonly [STT_RECOVERY_CONTROL]?: SttRecoveryControl;
}

export function getSttRecoveryControl(stream: SttStream): SttRecoveryControl | undefined {
  return (stream as RecoveryBrandedStream)[STT_RECOVERY_CONTROL];
}
