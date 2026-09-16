import type { PersonaConfig, SessionId } from "@tvic/core";

import { withTimeout } from "./async-control.js";

export async function resolveTurnSystemPrompt(
  resolver: PersonaConfig["systemPromptForTurn"] | undefined,
  sessionId: SessionId,
  turnNumber: number,
  setInstructions: (instructions: string | undefined) => void,
): Promise<void> {
  if (!resolver) return;
  try {
    const result = await withTimeout(resolver({ sessionId, turnNumber }), 1_000);
    setInstructions(result.instructionsOverride);
  } catch {
    // Per-turn persona context is advisory and cannot block a live call.
    setInstructions(undefined);
  }
}
