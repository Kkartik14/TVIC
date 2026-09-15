import type { CallHandle, Turn } from "@tvic/core";

import { withTimeout } from "./async-control.js";
import { TEXT_DELIVERY_TIMEOUT_MS } from "./pipeline-constants.js";

export type TextDeliveryMode = "auto" | "always" | "never";

export interface TextDeliveryDecision {
  readonly mode?: TextDeliveryMode;
  readonly audioDelivered: boolean;
  readonly hasTransport: boolean;
  readonly cancelledByBargeIn: boolean;
}

/** Decides whether participant-visible text should be attempted for a terminal turn. */
export function shouldDeliverText(decision: TextDeliveryDecision): boolean {
  if (!decision.hasTransport || decision.cancelledByBargeIn || decision.mode === "never") {
    return false;
  }
  return decision.mode === "always" || !decision.audioDelivered;
}

export async function deliverAssistantText(options: {
  readonly callHandle: CallHandle;
  readonly turn: Turn;
  readonly text: string;
  readonly mode?: TextDeliveryMode;
  readonly audioDelivered: boolean;
  readonly cancelledByBargeIn: boolean;
  /** Internal seam for deterministic tests and slow text transports. */
  readonly timeoutMs?: number;
}): Promise<boolean | undefined> {
  const deliver = options.callHandle.deliverText;
  if (
    !options.text ||
    !deliver ||
    !shouldDeliverText({
      ...(options.mode ? { mode: options.mode } : {}),
      audioDelivered: options.audioDelivered,
      hasTransport: true,
      cancelledByBargeIn: options.cancelledByBargeIn,
    })
  ) {
    return undefined;
  }
  try {
    return await withTimeout(
      Promise.resolve().then(() =>
        deliver.call(options.callHandle, options.turn.id, options.turn.sequence, options.text),
      ),
      options.timeoutMs ?? TEXT_DELIVERY_TIMEOUT_MS,
      false,
    );
  } catch {
    return false;
  }
}
