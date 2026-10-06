import type { CallHandle, StreamEndReason } from "@tvic/core";
import { normalizeUnknownError, timeoutError, TvicThrowableError } from "@tvic/core";

const MANAGED_END_INPUT_TIMEOUT_MS = 5_000;

export type ManagedEndInputOutcome =
  | { readonly status: "ended" }
  | { readonly status: "cancelled" }
  | { readonly status: "failed"; readonly error: TvicThrowableError };

export function endInputWithinDeadline(
  handle: CallHandle,
  endInput: NonNullable<CallHandle["endInput"]>,
  reason: StreamEndReason,
  signal: AbortSignal,
): Promise<ManagedEndInputOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: ManagedEndInputOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const onAbort = (): void => finish({ status: "cancelled" });

    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    timer = setTimeout(
      () =>
        finish({
          status: "failed",
          error: TvicThrowableError.from(
            timeoutError(
              "voice_runtime.end_input_timeout",
              `Ending call input exceeded its ${MANAGED_END_INPUT_TIMEOUT_MS}ms deadline`,
            ),
          ),
        }),
      MANAGED_END_INPUT_TIMEOUT_MS,
    );

    void Promise.resolve()
      .then(() => {
        if (settled || signal.aborted) {
          if (!settled) onAbort();
          return undefined;
        }
        return endInput.call(handle, reason);
      })
      .then(
        () => finish({ status: "ended" }),
        (error: unknown) =>
          finish({
            status: "failed",
            error: TvicThrowableError.from(
              normalizeUnknownError(error, {
                code: "voice_runtime.end_input_failed",
                category: "provider",
                retriable: false,
              }),
            ),
          }),
      );
  });
}
