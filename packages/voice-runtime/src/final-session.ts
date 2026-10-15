import type { Session, SessionId, TerminalSession } from "@tvic/core";
import { internalError, isTerminalSession, TvicThrowableError } from "@tvic/core";

const FINAL_SESSION_READ_TIMEOUT_MS = 1_000;

export function resolveFinalSessionAfterFinalization(input: {
  readonly finalization: Promise<void>;
  readonly sessionId: SessionId;
  readonly getSession: (sessionId: SessionId) => Promise<Session | null>;
}): Promise<TerminalSession> {
  return (async () => {
    let finalizationError: unknown;
    try {
      await input.finalization;
    } catch (error) {
      finalizationError = error;
    }

    let terminal: Session | null;
    try {
      terminal = await getSessionWithinDeadline(
        input.getSession(input.sessionId),
        FINAL_SESSION_READ_TIMEOUT_MS,
      );
    } catch (error) {
      if (finalizationError !== undefined) throw finalizationError;
      throw error;
    }
    if (terminal && isTerminalSession(terminal)) return terminal;
    if (finalizationError !== undefined) throw finalizationError;
    throw TvicThrowableError.from(
      internalError(
        "voice_runtime.terminal_session_missing",
        "The finalized call has no persisted terminal session",
      ),
    );
  })();
}

function getSessionWithinDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        TvicThrowableError.from(
          internalError(
            "voice_runtime.terminal_session_read_timeout",
            "The terminal session could not be read before the finalization deadline",
          ),
        ),
      );
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
