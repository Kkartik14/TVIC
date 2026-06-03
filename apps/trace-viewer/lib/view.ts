import type { CallInspection, PlayoutState, SpanView, TurnInspection } from "@tvic/tracing";

// Pure view helpers for the call inspection UI. Kept out of React so they can be unit
// tested without a DOM, and so components stay dumb (formatting + layout math only).

export function fmtMs(value: number | null | undefined): string {
  return value === null || value === undefined ? "–" : `${Math.round(value)}ms`;
}

export function fmtSeconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

/** Clamps a 0..100 number to a CSS percentage string. */
export function pct(value: number): string {
  return `${Math.max(0, Math.min(100, value))}%`;
}

/** Picks the turn to show: the `?turn=` param if it exists in the call, else the first. */
export function selectInitialTurn(
  call: { readonly turns: readonly { readonly turnId: string }[] },
  turnParam?: string,
): string | undefined {
  if (turnParam && call.turns.some((turn) => turn.turnId === turnParam)) {
    return turnParam;
  }
  return call.turns[0]?.turnId;
}

/** Left/width percentages of a span within its turn's [startedMs, endedMs] range. */
export function spanBox(span: SpanView, turn: TurnInspection): { left: string; width: string } {
  const span_ = Math.max(1, turn.endedMs - turn.startedMs);
  return {
    left: pct(((span.startMs - turn.startedMs) / span_) * 100),
    width: pct((Math.max(0, span.endMs - span.startMs) / span_) * 100),
  };
}

/** Position (0..100) of an absolute call-clock offset within the call timeline. */
export function cursorPct(ms: number, call: Pick<CallInspection, "startMs" | "endMs">): number {
  const span = Math.max(1, call.endMs - call.startMs);
  return Math.max(0, Math.min(100, ((ms - call.startMs) / span) * 100));
}

/** Human label for whether the agent's reply was actually heard (turn-level fidelity). */
export function playoutLabel(state: PlayoutState): string {
  switch (state) {
    case "heard":
      return "heard";
    case "unconfirmed":
      return "sent, not confirmed";
    case "cancelled":
      return "cancelled";
    case "none":
      return "no audio";
  }
}

/** The headline response latency is "hot" when it blows the ≤1s p50 budget. */
export function isHotResponse(turn: TurnInspection): boolean {
  return (turn.latency.firstAudioMs ?? 0) > 1000;
}

/** Seconds offset on the shared call clock for an absolute call-clock ms. */
export function toAudioSeconds(ms: number, call: Pick<CallInspection, "startMs">): number {
  return Math.max(0, (ms - call.startMs) / 1000);
}
