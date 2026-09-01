/**
 * Shared helper for rendering the pre-call memory block as a
 * human-readable system-prompt snippet. Used by all three
 * memory-demo sub-demos. Not part of the runtime contract — this
 * is illustrative.
 */
import type { PreCallContext } from "@tvic/core";
import { formatPreCallContextAsSystemBlock } from "@tvic/runtime";

export function formatMemoryBlock(preCall: PreCallContext | undefined): string {
  return formatPreCallContextAsSystemBlock(
    preCall ?? {
      memory: new Map(),
      static: new Map(),
      resolvedAtMs: 0,
      degraded: { memory: false, static: false },
    },
  );
}
