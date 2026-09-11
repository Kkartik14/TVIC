import { internalError, TvicThrowableError, type NormalizedError } from "@tvic/core";

export type CleanupStage =
  | "call.close"
  | "runtime.endSession"
  | "runtime.stop"
  | "late.call.close"
  | "late.runtime.endSession"
  | "late.runtime.stop";

export interface CleanupErrorSummary {
  readonly stage: CleanupStage;
  readonly code: string;
  readonly message: string;
}

export interface VoiceRuntimeFailureMetadata {
  readonly degraded: boolean;
  readonly callClosed: boolean;
  readonly sessionEnded: boolean;
  readonly timedOut: boolean;
  readonly lateCleanupPending: boolean;
  readonly primaryCode: string;
  readonly cleanupErrors: readonly CleanupErrorSummary[];
}

function normalizedErrorSummary(error: NormalizedError | null): Readonly<{
  name: string;
  code: string;
  category: string;
  message: string;
  retriable: boolean;
  provider?: string;
}> | null {
  if (!error) return null;
  return {
    name: error.name,
    code: error.code,
    category: error.category,
    message: error.message.slice(0, 4096),
    retriable: error.retriable,
    ...(error.provider ? { provider: error.provider.slice(0, 256) } : {}),
  };
}

export class VoiceRuntimeFinalizationError extends TvicThrowableError {
  constructor(
    raw: NormalizedError | null,
    cleanupErrors: readonly CleanupErrorSummary[],
    metadata: VoiceRuntimeFailureMetadata,
  ) {
    const boundedCleanup = cleanupErrors.slice(0, 8);
    const safeMetadata: VoiceRuntimeFailureMetadata = Object.freeze({
      degraded: metadata.degraded,
      callClosed: metadata.callClosed,
      sessionEnded: metadata.sessionEnded,
      timedOut: metadata.timedOut,
      lateCleanupPending: metadata.lateCleanupPending,
      primaryCode: metadata.primaryCode.slice(0, 128),
      cleanupErrors: Object.freeze(boundedCleanup.map((item) => ({ ...item }))),
    });
    super(
      internalError(
        "voice_runtime.finalization_failed",
        "Voice runtime cleanup did not complete successfully",
        {
          cause: {
            kind: "voice_runtime.finalization",
            raw: normalizedErrorSummary(raw),
            cleanup: safeMetadata.cleanupErrors,
          },
          metadata: { ...safeMetadata },
        },
      ),
    );
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
