import { afterEach, describe, expect, it, vi } from "vitest";

import type { Session, SessionId } from "@tvic/core";
import { internalError, TvicThrowableError } from "@tvic/core";
import { resolveFinalSessionAfterFinalization } from "../src/final-session.js";

describe("managed session finalization", () => {
  afterEach(() => vi.useRealTimers());

  it("bounds the persisted terminal-session read after finalization", async () => {
    vi.useFakeTimers();
    const finalSession = resolveFinalSessionAfterFinalization({
      finalization: Promise.resolve(),
      sessionId: "final_session_timeout" as SessionId,
      getSession: () => new Promise<Session | null>(() => undefined),
    });
    const assertion = expect(finalSession).rejects.toMatchObject({
      code: "voice_runtime.terminal_session_read_timeout",
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it("preserves the managed shutdown deadline when no terminal session was persisted", async () => {
    const deadline = TvicThrowableError.from(
      internalError(
        "voice_runtime.shutdown_failed",
        "A call did not reach finalization before the voice agent shutdown deadline",
        {
          metadata: {
            degraded: true,
            timedOut: true,
            lateCleanupPending: true,
            finalizationStarted: false,
          },
        },
      ),
    );
    await expect(
      resolveFinalSessionAfterFinalization({
        finalization: Promise.reject(deadline),
        sessionId: "final_session_deadline" as SessionId,
        getSession: async () => ({ status: "active" }) as Session,
      }),
    ).rejects.toMatchObject({
      code: "voice_runtime.shutdown_failed",
      metadata: { timedOut: true, lateCleanupPending: true, finalizationStarted: false },
    });
  });
});
