/**
 * CLI sub-demo. Operator passes `--user-id ada` on the command line.
 * The demo creates a runtime with a user-scoped memory, simulates a
 * first call where the agent learns the caller's name, then simulates a
 * second call where the agent greets them by name (the memory is loaded
 * by the runtime's pre-call loader).
 *
 * Usage: pnpm start:cli -- --user-id ada
 *        pnpm start:cli -- --user-id ada --memory postgres --database-url postgres://...
 */
import { type UserId } from "@tvic/core";
import { createRuntime } from "@tvic/runtime";

import { buildMemoryDemoAgent } from "../agent.js";
import {
  buildDemoCall,
  createMemoryDemoMemory,
  createPostgresMemoryDemoMemory,
  type ConfiguredMemory,
} from "../memory-runtime.js";
import { formatMemoryBlock } from "../format-memory-block.js";

interface CliArgs {
  userId: UserId;
  memory: ConfiguredMemory;
}

async function parseArgs(argv: readonly string[]): Promise<CliArgs> {
  let userId: UserId | undefined;
  let memoryKind: "in-memory" | "postgres" = "in-memory";
  let databaseUrl: string | undefined;
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--user-id" && i + 1 < argv.length) {
      userId = argv[i + 1] as UserId;
      i += 1;
    } else if (arg === "--memory" && i + 1 < argv.length) {
      const value = argv[i + 1];
      if (value === "in-memory" || value === "postgres") memoryKind = value;
      i += 1;
    } else if (arg === "--database-url" && i + 1 < argv.length) {
      databaseUrl = argv[i + 1];
      i += 1;
    }
  }
  if (!userId) {
    throw new Error("missing required --user-id <id>");
  }
  if (memoryKind === "postgres") {
    if (!databaseUrl) {
      throw new Error("--memory postgres requires --database-url");
    }
    return { userId, memory: await createPostgresMemoryDemoMemory(databaseUrl) };
  }
  return { userId, memory: createMemoryDemoMemory() };
}

async function main(): Promise<void> {
  const args = await parseArgs(process.argv);
  const runtime = createRuntime({ memory: args.memory.memory });
  await runtime.start();
  const agent = buildMemoryDemoAgent();
  const call = buildDemoCall("demo-call", args.userId);
  const channel = "simulated" as const;

  console.log("\n=== Call 1: agent learns the caller's name ===\n");
  const firstAttachment = await runtime.startAttachedSession(agent, {
    channel,
    call,
    memoryUserId: args.userId,
  });
  await firstAttachment.detach();

  // The agent would have called `remember_fact` during the LLM turn. In a
  // real voice flow that happens via the LLM tool. In this CLI demo we
  // simulate the same write directly to the memory adapter — the runtime
  // does not care who writes, only that the entry is there.
  const memory = args.memory.memory;
  await memory.put(
    { scope: "user", userId: args.userId },
    "preferred_name",
    "fact",
    "Ada Lovelace",
  );
  await memory.put({ scope: "user", userId: args.userId }, "account_id", "fact", "ACC-8821");
  await memory.put({ scope: "user", userId: args.userId }, "favorite_color", "fact", "blue");

  console.log("\n=== Call 2 (next day): agent greets by name ===\n");
  const secondAttachment = await runtime.startAttachedSession(agent, {
    channel,
    call: buildDemoCall("demo-call-2", args.userId),
    memoryUserId: args.userId,
  });
  const memoryBlock = formatMemoryBlock(secondAttachment.preCallContext);
  console.log("Pre-call memory block injected into the system prompt:");
  console.log(memoryBlock);
  console.log("");
  await secondAttachment.detach();

  console.log("=== Cleanup ===\n");
  await runtime.stop();
  await args.memory.stopExternalServices();
  console.log("OK: cross-call memory demo finished cleanly.");
}

main().catch((error: unknown) => {
  console.error("FATAL:", error);
  process.exit(1);
});
