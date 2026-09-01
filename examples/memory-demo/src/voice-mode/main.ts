/**
 * Voice-mode sub-demo (memory-demo). Browser WebSocket shape, but the
 * sub-demo's purpose is to demonstrate the cross-call memory contract, not
 * to be a runnable voice agent. The actual voice pipeline is exercised
 * by the existing `examples/voice-mode`; this script shows what the
 * pre-call memory block looks like in the runtime's pipeline so a CTO can
 * see the contract working end-to-end.
 *
 * Usage: pnpm start:voice-mode -- --user-id ada [--database-url postgres://...]
 */
import { createInMemoryMemory } from "@tvic/dal";
import { type UserId } from "@tvic/core";
import { createRuntime } from "@tvic/runtime";

import { buildMemoryDemoAgent } from "../agent.js";
import {
  buildDemoCall,
  createPostgresMemoryDemoMemory,
  type ConfiguredMemory,
} from "../memory-runtime.js";
import { formatMemoryBlock } from "../format-memory-block.js";

interface Args {
  userId: UserId;
  databaseUrl: string | undefined;
}

function parseArgs(argv: readonly string[]): Args {
  let userId: UserId | undefined;
  let databaseUrl: string | undefined;
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--user-id" && i + 1 < argv.length) {
      userId = argv[i + 1] as UserId;
      i += 1;
    } else if (arg === "--database-url" && i + 1 < argv.length) {
      databaseUrl = argv[i + 1];
      i += 1;
    }
  }
  if (!userId) {
    throw new Error("missing required --user-id <id>");
  }
  return { userId, databaseUrl };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const memoryBundle: ConfiguredMemory = args.databaseUrl
    ? await createPostgresMemoryDemoMemory(args.databaseUrl)
    : { memory: createInMemoryMemory(), stopExternalServices: async () => undefined };

  const runtime = createRuntime({ memory: memoryBundle.memory });
  await runtime.start();
  const agent = buildMemoryDemoAgent();
  const call = buildDemoCall("memory-demo-voice-mode-call-1", args.userId);

  console.log("\n=== Voice-mode call 1 ===\n");
  const firstAttachment = await runtime.startAttachedSession(agent, {
    channel: "web_audio",
    call,
    memoryUserId: args.userId,
  });
  await memoryBundle.memory.put(
    { scope: "user", userId: args.userId },
    "preferred_name",
    "fact",
    "Ada Lovelace",
  );
  await firstAttachment.detach();

  console.log("\n=== Voice-mode call 2 (next day) ===\n");
  const secondAttachment = await runtime.startAttachedSession(agent, {
    channel: "web_audio",
    call: buildDemoCall("memory-demo-voice-mode-call-2", args.userId),
    memoryUserId: args.userId,
  });
  console.log("Pre-call memory block on call 2:");
  console.log(formatMemoryBlock(secondAttachment.preCallContext));
  console.log("");
  await secondAttachment.detach();

  await runtime.stop();
  await memoryBundle.stopExternalServices();
  console.log("OK: voice-mode sub-demo finished cleanly.");
}

main().catch((error: unknown) => {
  console.error("FATAL:", error);
  process.exit(1);
});
