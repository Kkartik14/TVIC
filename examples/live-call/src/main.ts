import { randomBytes } from "node:crypto";

import {
  createInMemoryMemory,
  createCartesiaTtsProvider,
  createDeepgramSttProvider,
  createNodeMediaPlane,
  createGroqChatLlmProvider,
  createTwilioMediaStreamsProvider,
  createVoiceAgent,
  defineTool,
  nowTimestamp,
  PCM16_16K_MONO,
  type Call,
  type CallId,
  type CallHandle,
  type Memory,
  type RuntimeOptions,
  type TwilioMediaStreamSocket,
  type UpgradeAuthorization,
  type VoiceAgent,
  type VoiceEvent,
} from "voice-runtime";
import { createConfiguredMemory } from "./memory-runtime.js";

import { loadConfig } from "./config.js";
import { authorizeStreamConnection, createTwimlRequestHandler } from "./gateway.js";
import { createStreamTokenStore, type CallIdentity } from "./security.js";
import { assertDurableRuntimeEnvironment, createConfiguredRuntime } from "./durable-runtime.js";
import { loadLocalEnv } from "./env.js";

const MAX_TWIML_BODY_BYTES = 64 * 1024;

loadLocalEnv();
const config = loadConfig();
const streamSecret = config.streamTokenSecret ?? randomBytes(32).toString("hex");
if (!config.streamTokenSecret) {
  console.warn("STREAM_TOKEN_SECRET unset. Generated a development-only per-process secret.");
}
const tokenStore = createStreamTokenStore(streamSecret, config.streamTokenTtlMs);

const telephony = createTwilioMediaStreamsProvider();
const stt = createDeepgramSttProvider({ apiKey: config.deepgramApiKey });
const llm = createGroqChatLlmProvider({
  apiKey: config.groqApiKey,
  ...(config.groqApiUrl ? { url: config.groqApiUrl } : {}),
});
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
  console.error(`[call] unhandled failure (${safeErrorCode(error)})`);
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
  let acceptedHandle: CallHandle | undefined;
  let sessionStarted = false;
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
        const accepted = await telephony.acceptWebSocket(socket, callId, sessionId, {
          ...(identity.twilioCallSid ? { expectedTwilioCallSid: identity.twilioCallSid } : {}),
          ...(identity.accountSid ? { expectedAccountSid: identity.accountSid } : {}),
        });
        handleCreated = true;
        acceptedHandle = accepted;
        return accepted;
      },
    });
    sessionStarted = true;
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
    console.error(`[call ${callId}] failed (${safeErrorCode(error)})`);
  } finally {
    if (!sessionStarted && acceptedHandle) {
      await acceptedHandle.close("error").catch(() => undefined);
    } else if (!handleCreated) {
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
      if (event.kind === "error") {
        console.log(
          `[call ${callId}] error code=${event.error.code} category=${event.error.category} retriable=${event.error.retriable}`,
        );
      } else if (event.kind === "call_ended") {
        console.log(
          `[call ${callId}] call_ended reason=${event.reason} total_turns=${event.totalTurns}`,
        );
      }
    }
  } catch {
    // The result Promise is the authoritative failure surface. The observer
    // still drains the ordered event prefix when a run rejects.
  }
}

function safeErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return "unknown";
}

function isProductionEnv(): boolean {
  return process.env.NODE_ENV === "production" || process.env.TVIC_ENV === "production";
}

async function main(): Promise<void> {
  // Fail fast in production rather than knowingly serving an unauthenticated public
  // webhook that mints stream tokens for any caller. There is deliberately no
  // production override for this boundary; development/tunnel runs can omit the
  // token and receive the explicit warning emitted by the request handler.
  if (!config.twilioAuthToken && isProductionEnv()) {
    throw new Error("TWILIO_AUTH_TOKEN is required in production");
  }

  // Validate the paired durable-service configuration before Memory creates a
  // PostgreSQL pool; partial deployments must fail without leaking a client.
  assertDurableRuntimeEnvironment();

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
    ]);
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) throw failure.reason;
  };

  const onRequest = createTwimlRequestHandler({
    tokenStore,
    twilioAuthToken: config.twilioAuthToken,
    publicHost: config.publicHost,
    twimlPath: config.twimlPath,
    mediaPath: config.mediaPath,
    maxBodyBytes: MAX_TWIML_BODY_BYTES,
    logger: console,
  });

  const plane = createNodeMediaPlane<CallIdentity>({
    port: config.port,
    path: config.mediaPath,
    onRequest,
    healthCheck: () => activeAgent.healthCheck(),
    authorizeUpgrade(_request, url, params): UpgradeAuthorization<CallIdentity> {
      const identity = authorizeStreamConnection(
        tokenStore,
        params.callId,
        url.searchParams.get("token"),
        url.searchParams.get("exp"),
      );
      if (!identity) {
        return { ok: false, statusCode: 401, reason: "invalid stream token" };
      }
      return { ok: true, context: identity };
    },
    onConnection({ socket, params, upgradeContext: identity }) {
      const callId = params.callId;
      if (!callId || !identity) {
        socket.close(4401, "missing stream identity");
        return;
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
      "  WARNING: TWILIO_AUTH_TOKEN unset. /twiml is UNAUTHENTICATED (will mint stream tokens for any caller). Dev/tunnel use only.",
    );
  }
}

void main();
