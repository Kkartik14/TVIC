import { createInMemoryMemory } from "@tvic/dal";
import {
  createCartesiaTtsProvider,
  createDeepgramSttProvider,
  createOpenAiResponsesLlmProvider,
  createWebClientAudioProvider,
  WEB_CLIENT_AUDIO_CLOSE_CODES,
  type ConnectionObservabilityEvent,
} from "@tvic/providers";
import { PipelineVoiceLoop, createNodeMediaPlane, createRuntime, defineAgent } from "@tvic/runtime";
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
import { createPrimedConversationPolicy } from "./conversation.js";
import { createVoiceRequestHandler, createVoiceUpgradeAuthorizer } from "./gateway.js";
import { createVoiceSessionStore, type VoiceSessionIdentity } from "./security.js";

const config = loadConfig();
const runtime = createRuntime();
const memory = createInMemoryMemory();
const onConnectionEvent = (event: ConnectionObservabilityEvent): void =>
  console.log("[voice transport]", event);
const telephony = createWebClientAudioProvider({
  maxSessionDurationMs: config.maxSessionDurationMs,
  onConnectionEvent,
});
const stt = createDeepgramSttProvider({ apiKey: config.deepgramApiKey });
const llm = createOpenAiResponsesLlmProvider({ apiKey: config.openaiApiKey });
const tts =
  config.cartesiaApiKey && config.cartesiaVoiceId
    ? createCartesiaTtsProvider({ apiKey: config.cartesiaApiKey, voiceId: config.cartesiaVoiceId })
    : undefined;

const sharedAgent = {
  id: "voice-mode-agent",
  name: "Voice Mode Agent",
  instructions: "Be concise, useful, and conversational. Ask one clarification at a time.",
  tools: [],
  audioPolicy: { input: PCM16_16K_MONO, output: PCM16_16K_MONO },
  memoryPolicy: { enabled: true, scopes: ["session", "user"] as const },
  providers: { telephony, stt, llm, ...(tts ? { tts } : {}) },
};
const pushToTalkAgent = defineAgent({
  ...sharedAgent,
  id: "voice-mode-push-to-talk",
  interruptionPolicy: { mode: "ignore", minSpeechMs: 200, trimOutputOnInterrupt: true },
});
const continuousAgent = defineAgent({
  ...sharedAgent,
  id: "voice-mode-continuous",
  interruptionPolicy: { mode: "graceful", minSpeechMs: 200, trimOutputOnInterrupt: true },
});
const tokenStore = createVoiceSessionStore({
  tokenSecret: config.streamTokenSecret,
  safetyIdentifierSecret: config.safetyIdentifierSecret,
  ttlMs: config.streamTokenTtlMs,
  concurrentSessionCap: config.concurrentSessionCap,
  maxSessionDurationMs: config.maxSessionDurationMs,
});
const activeCalls = new Map<string, CallId>();

function buildCall(identity: VoiceSessionIdentity): Call {
  const now = nowTimestamp();
  return {
    id: identity.sessionRef as CallId,
    provider: "web-client-audio",
    direction: "inbound",
    from: identity.userId,
    to: "voice-agent",
    status: "connected",
    mediaTransport: { kind: "websocket", format: PCM16_16K_MONO },
    createdAt: now,
    startedAt: now,
  };
}

async function handleConnection(
  identity: VoiceSessionIdentity,
  socket: Parameters<typeof telephony.acceptWebSocket>[0],
): Promise<void> {
  const callId = identity.sessionRef as CallId;
  const agent = identity.mode === "push_to_talk" ? pushToTalkAgent : continuousAgent;
  let session: ActiveSession | undefined;
  let endRequest: EndSessionRequest = { reason: "completed" };
  activeCalls.set(identity.sessionRef, callId);
  try {
    session = await runtime.startSession(agent, {
      channel: "web_audio",
      call: buildCall(identity),
    });
    const handle = await telephony.acceptWebSocket(socket, callId, session.id, {
      expectedMode: identity.mode,
    });
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent,
      callHandle: handle,
      llmModel: config.llmModel,
      memory,
      memoryUserId: identity.memoryUserId,
      safetyIdentifier: identity.safetyIdentifier,
      conversationPolicy: await createPrimedConversationPolicy(
        memory,
        agent,
        identity.memoryUserId,
      ),
      onAssistantText: (record) => console.log("[assistant text]", record),
      onTurnLatency: (record) => console.log("[turn latency]", record),
    });
    const result = await loop.run();
    if (result.turnsFailed) {
      endRequest = {
        reason: "failed",
        error: result.firstTurnError ?? internalError("voice_mode.turn_failed", "Turn failed"),
      };
    }
  } catch (error) {
    endRequest = {
      reason: "failed",
      error: internalError(
        "voice_mode.failed",
        error instanceof Error ? error.message : String(error),
      ),
    };
  } finally {
    activeCalls.delete(identity.sessionRef);
    tokenStore.release(identity.sessionRef);
    if (session) await runtime.endSession(session.id, endRequest).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  await runtime.start();
  const requestHandler = createVoiceRequestHandler({
    tokenStore,
    allowedOrigins: config.allowedOrigins,
    authSecret: config.authSecret,
    adminSecret: config.adminSecret,
    mintRateLimitPerMinute: config.mintRateLimitPerMinute,
    onConnectionEvent,
    async terminateSession(sessionRef) {
      const callId = activeCalls.get(sessionRef);
      if (!callId) return false;
      await telephony.hangup(callId);
      return true;
    },
    async supersedeSession(sessionRef) {
      const callId = activeCalls.get(sessionRef);
      if (callId) await telephony.supersede(callId);
    },
  });
  const plane = createNodeMediaPlane<VoiceSessionIdentity>({
    port: config.port,
    path: config.path,
    onRequest: requestHandler,
    authorizeUpgrade: createVoiceUpgradeAuthorizer({
      tokenStore,
      allowedOrigins: config.allowedOrigins,
      onConnectionEvent,
    }),
    onUpgradeAborted: (identity) => tokenStore.release(identity.sessionRef),
    onConnection({ socket, upgradeContext }) {
      if (!upgradeContext) {
        socket.close(4401, "missing identity");
        return;
      }
      void handleConnection(upgradeContext, socket).catch((error) => {
        console.error("[voice] connection failed", error);
        socket.close();
      });
    },
  });
  await plane.start();
  console.log(`TVIC voice-mode gateway listening on :${config.port}`);
  console.log(
    "Voice mode is a separate deployable from the live-call gateway for capacity isolation.",
  );
}

void main();

export { WEB_CLIENT_AUDIO_CLOSE_CODES };
