import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { deriveCallTimeline, type TurnView } from "@tvic/tracing";
import type { TraceEvent } from "@tvic/core";

function fmt(ms: number | undefined): string {
  return ms === undefined ? "   -  " : `${Math.round(ms).toString().padStart(4, " ")}ms`;
}

function resolveJsonlPath(arg: string): string {
  return arg.endsWith(".jsonl") ? arg : join(arg, "call.jsonl");
}

async function loadEvents(path: string): Promise<readonly TraceEvent[]> {
  const body = await readFile(path, "utf8");
  return body
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as TraceEvent);
}

function printTurn(turn: TurnView): void {
  const tag = turn.sequence !== undefined ? `turn ${turn.sequence}` : turn.turnId;
  const label = `${tag} [${turn.status}]${turn.interrupted ? " ⚡interrupted" : ""}`;
  console.log(`\n${label}`);
  if (turn.transcript) {
    console.log(`  caller : "${turn.transcript}"`);
  }
  if (turn.response) {
    console.log(`  agent  : "${turn.response}"`);
  }
  const m = turn.metrics;
  console.log(
    `  EOU@ ${fmt(m.endOfUtteranceMs)}   TTFT ${fmt(m.ttftMs)}   TTS TTFB ${fmt(m.ttfbMs)}` +
      `   tool ${fmt(m.toolMs)}   response ${fmt(m.responseLatencyMs)}   total ${fmt(m.totalMs)}`,
  );
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: pnpm --filter @tvic/example-live-call latency <call-dir | call.jsonl>");
    process.exit(1);
    return;
  }

  const events = await loadEvents(resolveJsonlPath(arg));
  const timeline = deriveCallTimeline(events);

  console.log(`call duration: ${Math.round(timeline.endMs - timeline.startMs)}ms`);
  console.log(`turns: ${timeline.turns.length}   interruptions: ${timeline.interruptions}`);
  for (const turn of timeline.turns) {
    printTurn(turn);
  }

  const responses = timeline.turns
    .map((turn) => turn.metrics.responseLatencyMs)
    .filter((value): value is number => typeof value === "number")
    .sort((a, b) => a - b);
  if (responses.length > 0) {
    const p = (q: number) =>
      responses[Math.min(responses.length - 1, Math.floor(q * responses.length))];
    console.log(
      `\nresponse latency  p50 ${fmt(p(0.5))}  p95 ${fmt(p(0.95))}  (n=${responses.length})`,
    );
  }
}

void main();
