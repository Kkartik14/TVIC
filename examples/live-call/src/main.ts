import { randomBytes } from "node:crypto";

import { createInMemoryMemory } from "@tvic/dal";
import {
  createCartesiaTtsProvider,
  createDeepgramSttProvider,
  createOpenAiResponsesLlmProvider,
  createTwilioMediaStreamsProvider,
  type TwilioMediaStreamSocket,
} from "@tvic/providers";
import {
  PipelineVoiceLoop,
  createNodeMediaPlane,
  createRuntime,
  defineAgent,
  defineTool,
} from "@tvic/runtime";
import {
  PCM16_16K_MONO,
  internalError,
  nowTimestamp,
  type ActiveSession,
  type Call,
  type CallId,
  type EndSessionRequest,
} from "@tvic/core";

import { loadConfig } from "./config.js";
import { authorizeStreamConnection, createTwimlRequestHandler } from "./gateway.js";
import { createStreamTokenStore, type CallIdentity } from "./security.js";

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
const memory = createInMemoryMemory();
const runtime = createRuntime();

const agent = defineAgent({
  id: "live-call-agent",
  name: "Live Call Agent",
  instructions:
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
  audioPolicy: { input: PCM16_16K_MONO, output: PCM16_16K_MONO },
  memoryPolicy: { enabled: true, scopes: ["session"] },
});

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

  // Everything after startSession is inside try/finally, so a failure in
  // acceptWebSocket or loop construction can never leak an active session.
  let session: ActiveSession | undefined;
  let endRequest: EndSessionRequest = { reason: "completed" };
  try {
    const started = await runtime.startSession(agent, { channel: "phone", call });
    session = started;
    const handle = await telephony.acceptWebSocket(socket, callId, started.id);

    const loop = new PipelineVoiceLoop({
      runtime,
      session: started,
      agent,
      callHandle: handle,
      llmModel: config.llmModel,
      ...(config.sttLanguage ? { sttLanguage: config.sttLanguage } : {}),
      memory,
    });

    console.log(`[call ${callId}] connected (session ${started.id})`);
    const result = await loop.run();
    if (result.turnsFailed > 0) {
      // The loop ran to the end, but a turn failed, so never report the call as clean.
      endRequest = {
        reason: "failed",
        error:
          result.firstTurnError ??
          internalError("live_call.turn_failed", `${result.turnsFailed} turn(s) failed`),
      };
      console.error(
        `[call ${callId}] degraded: ${result.turnsHandled} turns, ${result.turnsFailed} failed`,
      );
    } else {
      console.log(
        `[call ${callId}] ended: ${result.turnsHandled} turns, ${result.interruptions} interruptions`,
      );
    }
  } catch (error) {
    endRequest = {
      reason: "failed",
      error: internalError(
        "live_call.failed",
        error instanceof Error ? error.message : String(error),
      ),
    };
    console.error(`[call ${callId}] failed:`, error);
  } finally {
    if (session) {
      await runtime.endSession(session.id, endRequest).catch(onCallError);
    }
  }
}

function isProductionEnv(): boolean {
  return process.env.NODE_ENV === "production" || process.env.TVIC_ENV === "production";
}

async function main(): Promise<void> {
  // Fail fast in production rather than knowingly serving an unauthenticated public
  // webhook that mints stream tokens for any caller. The dev/tunnel unauthenticated
  // mode stays available, but only behind an explicit opt-in flag.
  if (
    !config.twilioAuthToken &&
    isProductionEnv() &&
    process.env.ALLOW_UNAUTHENTICATED_TWIML !== "true"
  ) {
    throw new Error(
      "TWILIO_AUTH_TOKEN is required in production. Set it, or set " +
        "ALLOW_UNAUTHENTICATED_TWIML=true to explicitly allow unauthenticated /twiml (dev/tunnel only).",
    );
  }

  await runtime.start();

  const onRequest = createTwimlRequestHandler({
    tokenStore,
    twilioAuthToken: config.twilioAuthToken,
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
    onConnection({ socket, url, params }) {
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
      // The media plane's `ws` socket structurally satisfies the provider's minimal
      // TwilioMediaStreamSocket interface (readyState/send/close/on), so it is passed
      // directly, with no `unknown as` escape hatch at the provider boundary.
      void handleCall(callId as CallId, identity, socket).catch(onCallError);
    },
  });

  await plane.start();
  console.log(`T-vic live-call gateway listening on :${config.port}`);
  console.log(`  Twilio Voice webhook  ->  https://${config.publicHost}${config.twimlPath}`);
  if (!config.twilioAuthToken) {
    console.warn(
      "  WARNING: TWILIO_AUTH_TOKEN unset. /twiml is UNAUTHENTICATED (will mint stream tokens for any caller). Dev/tunnel use only.",
    );
  }
}

void main();
