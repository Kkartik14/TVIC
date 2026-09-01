/**
 * Worked example: `agent.persona: PersonaConfig`.
 *
 * One agent, many tenants. The persona hook resolves the per-tenant
 * context at session start — instructions override + variable values
 * (e.g. `{{customer_name}} = "Ada"`) that get injected into the
 * system prompt. The user picks the source of truth (mocked CRM here);
 * the runtime does not.
 *
 * Usage:
 *   pnpm start -- --user-id ada --tenant acme
 *   pnpm start -- --user-id bob --tenant globex
 */
import { createInMemoryMemory } from "@tvic/dal";
import { createRuntime, defineAgent } from "@tvic/runtime";
import {
  PCM16_16K_MONO,
  type Agent,
  type Call,
  type MediaTransport,
  type Memory,
  type OrganizationId,
  type RingingCall,
  type UserId,
} from "@tvic/core";
import { mockCrm, type CrmRecord } from "./mock-crm.js";

interface Args {
  userId: UserId;
  organizationId: OrganizationId;
}

function parseArgs(argv: readonly string[]): Args {
  let userId: UserId | undefined;
  let organizationId: OrganizationId | undefined;
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--user-id" && i + 1 < argv.length) {
      userId = argv[i + 1] as UserId;
      i += 1;
    } else if (arg === "--tenant" && i + 1 < argv.length) {
      organizationId = argv[i + 1] as OrganizationId;
      i += 1;
    }
  }
  if (!userId) {
    throw new Error("missing required --user-id <id>");
  }
  if (!organizationId) {
    throw new Error("missing required --tenant <id>");
  }
  return { userId, organizationId };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const memory: Memory = createInMemoryMemory();

  const agent: Agent = defineAgent({
    id: "persona-demo-agent",
    name: "Persona Demo Agent",
    instructions:
      "You are a customer service agent. Greet the caller by name and address them by their company. " +
      "The system prompt will be enriched with persona context at session start.",
    tools: [],
    audioPolicy: { input: PCM16_16K_MONO, output: PCM16_16K_MONO },
    memoryPolicy: {
      enabled: true,
      scopes: ["user", "organization"],
      preCallLoad: "all",
    },
    providers: {
      telephony: {
        name: "demo-telephony",
        kind: "telephony",
        version: "0.1.0",
        capabilities: TEST_PROVIDER_CAPABILITIES,
        accept: async () => undefined as never,
        hangup: async () => undefined,
      } as never,
      stt: {
        name: "demo-stt",
        kind: "stt",
        version: "0.1.0",
        capabilities: TEST_PROVIDER_CAPABILITIES,
        open: async () => {
          async function* empty() {}
          return { events: empty(), close: async () => undefined };
        },
      } as never,
      llm: {
        name: "demo-llm",
        kind: "llm",
        version: "0.1.0",
        capabilities: TEST_PROVIDER_CAPABILITIES,
        complete: () => Promise.resolve({ text: "Hello.", finishReason: "stop" as const }),
      } as never,
    },
    interruptionPolicy: { mode: "allow" as const, minSpeechMs: 250, trimOutputOnInterrupt: false },
    timeoutPolicy: { timeoutMs: 30_000, onTimeout: "fail" },
    persona: {
      resolveTenantContext: async (input) => {
        const crm: CrmRecord | null = await mockCrm(input.userId, input.organizationId);
        if (!crm) {
          return {
            variables: new Map([
              ["customer_name", "valued customer"],
              ["company", "your company"],
            ]),
          };
        }
        return {
          instructionsOverride:
            `You are a customer service agent for ${crm.company}. ` +
            `Address the caller by their first name (${crm.firstName}). ` +
            `Their account is in good standing. ` +
            `Their last interaction was about ${crm.lastTopic}.`,
          variables: new Map<string, string>([
            ["customer_name", crm.firstName],
            ["company", crm.company],
            ["account_id", crm.accountId],
          ]),
        };
      },
    },
  });

  const runtime = createRuntime({
    memory,
    defaultOrganizationId: args.organizationId,
  });
  await runtime.start();

  console.log("\n=== Simulated call ===\n");
  const call = buildDemoCall("persona-demo-1", args.userId);
  const a = await runtime.startAttachedSession(agent, {
    channel: "simulated",
    call,
    memoryUserId: args.userId,
    organizationId: args.organizationId,
  });
  await a.detach();

  console.log("=== Pre-call memory block on call 2 ===\n");
  const a2 = await runtime.startAttachedSession(agent, {
    channel: "simulated",
    call: buildDemoCall("persona-demo-2", args.userId),
    memoryUserId: args.userId,
    organizationId: args.organizationId,
  });
  await a2.detach();
  await runtime.stop();

  console.log("OK: persona demo finished cleanly.");
  console.log("Try: pnpm start -- --user-id ada --tenant acme");
  console.log("     pnpm start -- --user-id bob --tenant globex");
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

const TEST_PROVIDER_CAPABILITIES = {
  streaming: { input: true, output: true, native: true },
  cancellation: { request: true, output: true, buffer: true, truncation: true },
  transports: ["websocket" as const],
  audio: { input: [PCM16_16K_MONO], output: [PCM16_16K_MONO] },
  tools: { functionCalling: true, parallelCalls: true },
  playout: { clearBuffer: true, acknowledgement: true, position: true },
};

main().catch((error: unknown) => {
  console.error("FATAL:", error);
  process.exit(1);
});
