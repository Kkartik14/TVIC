/**
 * Worked example of the `RuntimeOptions.onSessionEnd` hook.
 *
 * The user picks the LLM, the prompt, the schema, and the memory writes.
 * The runtime owns the lifecycle: the hook fires after `endSession`
 * terminalizes and after session-scope memory is purged. The hook is
 * best-effort — a throw is logged but does not affect the terminal
 * session. The runtime does not retry.
 *
 * This example uses an offline summarizer that returns a deterministic summary
 * based on the call id. To wire a real LLM, replace `buildSummarizer`
 * with a call to OpenAI / Anthropic / your local model.
 *
 * Usage:
 *   pnpm start -- --user-id ada
 */
import { createInMemoryMemory } from "@tvic/dal";
import { createRuntime, type Runtime, type SessionEndEvent } from "@tvic/runtime";
import {
  PCM16_16K_MONO,
  type Agent,
  type Call,
  type MediaTransport,
  type Memory,
  type RingingCall,
  type UserId,
} from "@tvic/core";
import { z } from "zod";

import { buildAgent, buildDeterministicSummarizer } from "./agent.js";

interface Args {
  userId: UserId;
}

function parseArgs(argv: readonly string[]): Args {
  let userId: UserId | undefined;
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--user-id" && i + 1 < argv.length) {
      userId = argv[i + 1] as UserId;
      i += 1;
    }
  }
  if (!userId) {
    throw new Error("missing required --user-id <id>");
  }
  return { userId };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const memory: Memory = createInMemoryMemory();
  const summarizer = buildDeterministicSummarizer();
  const agent: Agent = buildAgent();

  // The schema the summarizer is expected to return. Zod is one option;
  // the user picks their validation library.
  const SummarizationResult = z.object({
    summary: z.string(),
    facts: z.array(z.string()),
  });

  const runtime: Runtime = createRuntime({
    memory,
    onSessionEnd: async (event: SessionEndEvent) => {
      const raw = await summarizer(event);
      const parsed = SummarizationResult.parse(raw);
      await memory.put(
        { scope: "user", userId: args.userId },
        "call_summary",
        "summary",
        parsed.summary,
      );
      for (const [i, fact] of parsed.facts.entries()) {
        await memory.put({ scope: "user", userId: args.userId }, `fact_${i}`, "fact", fact);
      }
    },
  });
  await runtime.start();

  console.log("=== Simulated call ===\n");
  const call = buildDemoCall("post-call-summarization-1", args.userId);
  const a = await runtime.startAttachedSession(agent, {
    channel: "simulated",
    call,
    memoryUserId: args.userId,
  });
  await memory.put(
    { scope: "user", userId: args.userId },
    "preferred_name",
    "fact",
    "Ada Lovelace",
  );
  console.log("=== End-of-call: onSessionEnd hook fires ===\n");
  await runtime.endSession(a.session.id, { reason: "completed" });

  console.log("=== Cross-call: next call sees the summary ===\n");
  const a2 = await runtime.startAttachedSession(agent, {
    channel: "simulated",
    call: buildDemoCall("post-call-summarization-2", args.userId),
    memoryUserId: args.userId,
  });
  const summaryEntry = await memory.get(
    { scope: "user", userId: args.userId },
    "call_summary",
    "summary",
  );
  console.log("Pre-call memory block on call 2:");
  console.log("  fact:preferred_name = Ada Lovelace");
  if (summaryEntry) {
    console.log(`  summary:call_summary = ${String(summaryEntry.value)}`);
  } else {
    console.log("  summary:call_summary = (not written)");
  }
  console.log("");
  await a2.detach();

  await runtime.stop();
  console.log("OK: post-call summarization demo finished cleanly.");
}

function buildDemoCall(id: string, from: UserId): RingingCall {
  const transport: MediaTransport = {
    kind: "websocket",
    format: PCM16_16K_MONO,
  };
  return {
    id: id as Call["id"],
    provider: "demo",
    direction: "inbound",
    from,
    to: "agent",
    status: "ringing",
    mediaTransport: transport,
    createdAt: new Date().toISOString() as Call["createdAt"],
  };
}

main().catch((error: unknown) => {
  console.error("FATAL:", error);
  process.exit(1);
});
