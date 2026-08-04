import type { NormalizedError, SessionId, Turn, TurnId } from "@tvic/core";

export interface AssistantTextRecord {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly sequence: number;
  readonly status: "completed" | "cancelled" | "failed";
  readonly text: string;
  readonly delivered?: boolean;
  readonly audioError?: NormalizedError;
}

export function reportAssistantText(
  report: ((record: AssistantTextRecord) => void) | undefined,
  sessionId: SessionId,
  turn: Turn,
  status: AssistantTextRecord["status"],
  text: string,
  delivered: boolean | undefined,
  audioError: NormalizedError | null,
): void {
  if (!report) return;
  try {
    report({
      sessionId,
      turnId: turn.id,
      sequence: turn.sequence,
      status,
      text,
      ...(delivered !== undefined ? { delivered } : {}),
      ...(audioError ? { audioError } : {}),
    });
  } catch {
    // Observation must never alter live execution.
  }
}
