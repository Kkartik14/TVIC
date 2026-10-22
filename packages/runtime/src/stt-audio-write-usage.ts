import type { SttAudioWriteUsageOperation } from "@tvic/core";

export function trackSttAudioWriteOutcome(
  send: Promise<void>,
  usageWrite: SttAudioWriteUsageOperation | undefined,
  onUsageError: (error: unknown) => void,
): Promise<void> {
  if (usageWrite) {
    void send
      .then(
        () => usageWrite.succeeded(),
        () => usageWrite.failed(),
      )
      .catch(onUsageError);
  }
  return send;
}
