import { randomBytes } from "node:crypto";
import { createClient } from "redis";

import {
  createInMemoryMemory,
  createCartesiaTtsProvider,
  createDeepgramSttProvider,
  createNodeMediaPlane,
  createOpenAiResponsesLlmProvider,
  createTwilioMediaStreamsProvider,
  createVoiceAgent,
  defineTool,
  nowTimestamp,
  PCM16_16K_MONO,
  type Call,
  type CallId,
  type Memory,
  type RuntimeOptions,
  type TwilioMediaStreamSocket,
  type VoiceAgent,
  type VoiceEvent,
} from "voice-runtime";
import { createConfiguredMemory } from "./memory-runtime.js";

import { isProductionEnv, loadConfig } from "./config.js";
import { authorizeStreamConnection, createTwimlRequestHandler } from "./gateway.js";
import {
  createInMemoryTwimlReplayStore,
  createRedisTwimlReplayStore,
  createStreamTokenStore,
  type CallIdentity,
  type TwimlReplayStore,
} from "./security.js";
import { createConfiguredRuntime } from "./durable-runtime.js";

const MAX_TWIML_BODY_BYTES = 64 * 1024;

const config = loadConfig();
const streamSecret = config.streamTokenSecret ?? randomBytes(32).toString("hex");
if (!config.streamTokenSecret) {
  console.warn("STREAM_TOKEN_SECRET unset. Generated an ephemeral per-process secret.");
}
const tokenStore = createStreamTokenStore(streamSecret, config.streamTokenTtlMs);

const telephony = createTwilioMediaStreamsProvider();
const stt = createDeepgramSttProvider({ apiKey: config.deepgramApiKey });
const llm = createOpenAiResponsesLlmProvider({ apiKey: config.openaiApiKey });
const tts = createCartesiaTtsProvider({
  apiKey: config.cartesiaApiKey,
  voiceId: config.cartesiaVoiceId,
  ...(config.cartesiaModel ? { modelId: config.cartesiaModel } : {}),
});
let memory: Memory = createInMemoryMemory();
let agent: VoiceAgent | undefined;
let stopMemoryServices: () => Promise<void> = async () => undefined;

function createLiveCallAgent(runtime: RuntimeOptions): VoiceAgent {
  return createVoiceAgent({
    id: "live-call-agent",
    name: "Live Call Agent",
    prompt:
      "You are a warm, concise phone receptionist for a restaurant. Greet the caller, " +
      "take a reservation (party size, time, name), confirm it, and keep replies short and natural.",
    tools: [
      defineTool({
        id: "check_availability",
        name: "check_availability",
        description: "Check whether the restaurant can seat a party at a given time.",
        inputSchema: {
          type: "object",
          properties: { partySize: { type: "number" }, time: { type: "string" } },
          required: ["partySize", "time"],
        },
        outputSchema: { type: "object" },
        async execute() {
          return { available: true, holdMinutes: 10 };
        },
      }),
    ],
    providers: { telephony, stt, llm, tts },
    audio: { input: PCM16_16K_MONO, output: PCM16_16K_MONO },
    memoryPolicy: { enabled: true, scopes: ["session"] },
    runtime,
    models: { llm: config.llmModel },
  });
}

function onCallError(error: unknown): void {
  console.error("[call] unhandled failure:", error);
}

function buildCall(callId: CallId, identity: CallIdentity): Call {
  const now = nowTimestamp();
  return {
    id: callId,
    provider: "twilio",
    direction: "inbound",
    from: identity.from,
    to: identity.to,
    status: "connected",
    mediaTransport: { kind: "websocket", format: PCM16_16K_MONO },
    createdAt: now,
    startedAt: now,
    ...(identity.twilioCallSid || identity.accountSid
      ? {
          metadata: {
            ...(identity.twilioCallSid ? { twilioCallSid: identity.twilioCallSid } : {}),
            ...(identity.accountSid ? { accountSid: identity.accountSid } : {}),
          },
        }
      : {}),
  };
}

async function handleCall(
  callId: CallId,
  identity: CallIdentity,
  socket: TwilioMediaStreamSocket,
): Promise<void> {
  const call = buildCall(callId, identity);

  if (!agent) {
    socket.close(1011, "voice agent is not ready");
    return;
  }
  let handleCreated = false;
  try {
    const session = await agent.start({
      channel: "phone",
      call,
      ...(config.sttLanguage ? { sttLanguage: config.sttLanguage } : {}),
      metadata: {
        ...(identity.twilioCallSid ? { twilioCallSid: identity.twilioCallSid } : {}),
        ...(identity.accountSid ? { accountSid: identity.accountSid } : {}),
      },
      callHandle: async ({ sessionId }) => {
        const accepted = await telephony.acceptWebSocket(socket, callId, sessionId);
        handleCreated = true;
        return accepted;
      },
    });
    console.log(`[call ${callId}] connected (session ${session.sessionId})`);
    const events = observeEvents(session.run, callId);
    void events.catch(() => undefined);
    const result = await session.run;
    await events;
    if (result.turnsFailed > 0) {
      console.error(
        `[call ${callId}] degraded: ${result.turnsHandled} turns, ${result.turnsFailed} failed`,
      );
    } else {
      console.log(
        `[call ${callId}] ended: ${result.turnsHandled} turns, ${result.interruptions} interruptions`,
      );
    }
  } catch (error) {
    console.error(`[call ${callId}] failed:`, error);
  } finally {
    if (!handleCreated) {
      try {
        socket.close(1011, "voice connection failed");
      } catch {
        // Raw socket teardown is best-effort before the provider handle is accepted.
      }
    }
  }
}

async function observeEvents(run: AsyncIterable<VoiceEvent>, callId: string): Promise<void> {
  try {
    for await (const event of run) {
      if (event.kind === "error" || event.kind === "call_ended") {
        console.log(`[call ${callId}] event`, event);
      }
    }
  } catch {
    // The result Promise is the authoritative failure surface. The observer
    // still drains the ordered event prefix when a run rejects.
  }
}

async function main(): Promise<void> {
  // A process-local replay map is safe for a development tunnel only. Production
  // requires Redis so concurrent gateway instances share the same reservation.
  const replayResources = await createReplayStore();
  if (isProductionEnv() && replayResources.store.scope !== "shared") {
    throw new Error("REDIS_URL is required in production for shared TwiML replay protection");
  }

  // Configure durable memory first; reassign the module-scope `memory`
  // so the pipeline loop (which closes over the original reference)
  // writes to the same durable adapter the runtime uses.
  const memoryConfigured = await createConfiguredMemory(memory);
  memory = memoryConfigured.memory;
  const configured = await createConfiguredRuntime(memory);
  agent = createLiveCallAgent(configured.options);
  const activeAgent = agent;
  stopMemoryServices = async () => {
    const results = await Promise.allSettled([
      configured.stopExternalServices(),
      memoryConfigured.stopExternalServices(),
      replayResources.close(),
    ]);
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) throw failure.reason;
  };

  const onRequest = createTwimlRequestHandler({
    tokenStore,
    replayStore: replayResources.store,
    twilioAuthToken: config.twilioAuthToken,
    allowUnauthenticatedTwiml: config.allowUnauthenticatedTwiml,
    replayTtlMs: config.twimlReplayTtlMs,
    publicHost: config.publicHost,
    twimlPath: config.twimlPath,
    mediaPath: config.mediaPath,
    maxBodyBytes: MAX_TWIML_BODY_BYTES,
    logger: console,
  });

  const plane = createNodeMediaPlane({
    port: config.port,
    path: config.mediaPath,
    onRequest,
    healthCheck: () => activeAgent.healthCheck(),
    async onConnection({ socket, url, params }) {
      const callId = params.callId;
      const identity = authorizeStreamConnection(
        tokenStore,
        callId,
        url.searchParams.get("token"),
        url.searchParams.get("exp"),
      );
      if (!identity) {
        console.warn(`[media] rejected unauthorized stream for ${callId ?? "<no call id>"}`);
        socket.close();
        return;
      }
      if (identity.replayKey) {
        try {
          await replayResources.store.markConsumed(identity.replayKey);
        } catch (error) {
          console.error("[media] could not finalize TwiML replay state", error);
          socket.close(1011, "replay state unavailable");
          return;
        }
      }
      // The media plane's `ws` socket structurally satisfies the provider's minimal
      // TwilioMediaStreamSocket interface (readyState/send/close/on), so it is passed
      // directly, with no `unknown as` escape hatch at the provider boundary.
      void handleCall(callId as CallId, identity, socket).catch(onCallError);
    },
  });

  await plane.start();
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[call] received ${signal}; shutting down`);
    await plane
      .stop()
      .catch((error: unknown) => console.error("[call] gateway stop failed", error));
    await activeAgent
      .stop()
      .catch((error: unknown) => console.error("[call] runtime stop failed", error));
    await stopMemoryServices().catch((error: unknown) =>
      console.error("[call] memory services stop failed", error),
    );
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  console.log(`T-vic live-call gateway listening on :${config.port}`);
  console.log(`  Twilio Voice webhook  ->  https://${config.publicHost}${config.twimlPath}`);
  if (!config.twilioAuthToken) {
    console.warn(
      "  WARNING: /twiml is running in explicit unauthenticated development mode; never expose this process publicly.",
    );
  }
}

interface ReplayResources {
  readonly store: TwimlReplayStore;
  readonly close: () => Promise<void>;
}

async function createReplayStore(): Promise<ReplayResources> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    return { store: createInMemoryTwimlReplayStore(), close: async () => undefined };
  }
  const client = createClient({ url: redisUrl });
  await client.connect();
  const store = createRedisTwimlReplayStore({
    get: (key) => client.get(key),
    eval: (script, keys, args) => client.eval(script, { keys: [...keys], arguments: [...args] }),
  });
  return {
    store,
    close: async () => {
      await client.quit().catch(() => undefined);
    },
  };
}

void main();
