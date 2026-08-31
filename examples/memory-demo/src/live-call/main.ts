/**
 * Live-call sub-demo (memory-demo). Twilio Media Streams shape, mirroring
 * `examples/live-call` but using the shared `buildMemoryDemoAgent` and
 * `createPostgresMemoryDemoMemory`. Requires Twilio credentials; for the
 * no-credentials path, run the CLI sub-demo (`pnpm start:cli -- --user-id
 * ada`) which exercises the same cross-call contract.
 *
 * Usage: pnpm start:live-call -- --user-id ada [--database-url postgres://...]
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
  const call = buildDemoCall("memory-demo-live-call-1", args.userId);

  console.log("\n=== Live-call 1 (Twilio) ===\n");
  const firstAttachment = await runtime.startAttachedSession(agent, {
    channel: "phone",
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

  console.log("\n=== Live-call 2 (next day) ===\n");
  const secondAttachment = await runtime.startAttachedSession(agent, {
    channel: "phone",
    call: buildDemoCall("memory-demo-live-call-2", args.userId),
    memoryUserId: args.userId,
  });
  console.log("Pre-call memory block on call 2:");
  console.log(formatMemoryBlock(secondAttachment.preCallContext));
  console.log("");
  await secondAttachment.detach();

  await runtime.stop();
  await memoryBundle.stopExternalServices();
  console.log("OK: live-call sub-demo finished cleanly.");
  console.log("Note: this script simulates the Twilio flow but does not run a real");
  console.log("Telephony gateway. For a runnable Twilio gateway, see examples/live-call");
  console.log("and use the same shared agent + memory wiring.");
}

main().catch((error: unknown) => {
  console.error("FATAL:", error);
  process.exit(1);
});
