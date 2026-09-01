import { createInMemoryMemory } from "@tvic/dal";
import type { Memory, Runtime } from "@tvic/core";
import {
  createCartesiaTtsProvider,
  createDeepgramSttProvider,
  createOpenAiResponsesLlmProvider,
  createWebClientAudioProvider,
  WEB_CLIENT_AUDIO_CLOSE_CODES,
  type ConnectionObservabilityEvent,
} from "@tvic/providers";
import { PipelineVoiceLoop, createNodeMediaPlane, defineAgent } from "@tvic/runtime";
import {
  PCM16_16K_MONO,
  internalError,
  nowTimestamp,
  type ActiveSession,
  type Call,
  type CallId,
  type EndSessionRequest,
  type SessionAttachment,
} from "@tvic/core";

import { loadConfig } from "./config.js";
import { createVoiceRequestHandler, createVoiceUpgradeAuthorizer } from "./gateway.js";
import { createVoiceSessionStore, type VoiceSessionIdentity } from "./security.js";
import { createMockVoiceProviders } from "./mock-providers.js";
import { createConfiguredRuntime } from "./durable-runtime.js";

import { createConfiguredMemory } from "./memory-runtime.js";

const config = loadConfig();
let runtime: Runtime | undefined;
let stopMemoryServices: () => Promise<void> = async () => undefined;
let memory: Memory = createInMemoryMemory();
const onConnectionEvent = (event: ConnectionObservabilityEvent): void =>
  console.log("[voice transport]", event);
const telephony = createWebClientAudioProvider({
  maxSessionDurationMs: config.maxSessionDurationMs,
  onConnectionEvent,
});
const mockProviders = config.providerMode === "mock" ? createMockVoiceProviders() : undefined;
const stt = mockProviders?.stt ?? createDeepgramSttProvider({ apiKey: config.deepgramApiKey });
const llm =
  mockProviders?.llm ??
  createOpenAiResponsesLlmProvider({ apiKey: config.llmApiKey, url: config.llmApiUrl });
const tts =
  mockProviders?.tts ??
  (config.cartesiaApiKey && config.cartesiaVoiceId
    ? createCartesiaTtsProvider({ apiKey: config.cartesiaApiKey, voiceId: config.cartesiaVoiceId })
    : undefined);

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
  metadata: { voiceMode: "push_to_talk" },
  interruptionPolicy: { mode: "ignore", minSpeechMs: 200, trimOutputOnInterrupt: true },
});
const continuousAgent = defineAgent({
  ...sharedAgent,
  id: "voice-mode-continuous",
  metadata: { voiceMode: "continuous" },
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
  let attachment: SessionAttachment | undefined;
  let handle: Awaited<ReturnType<typeof telephony.acceptWebSocket>> | undefined;
  let endRequest: EndSessionRequest = { reason: "completed" };
  activeCalls.set(identity.sessionRef, callId);
  if (!runtime) return;
  try {
    attachment = await runtime.startAttachedSession(agent, {
      channel: "web_audio",
      call: buildCall(identity),
      memoryUserId: identity.memoryUserId,
    });
    session = attachment.session;
    handle = await telephony.acceptWebSocket(socket, callId, session.id, {
      expectedMode: identity.mode,
    });
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent,
      attachment,
      callHandle: handle,
      llmModel: config.llmModel,
      memory,
      memoryUserId: identity.memoryUserId,
      safetyIdentifier: identity.safetyIdentifier,
      // The runtime's pre-call memory loader now produces the system-prompt
      // context automatically; the example no longer needs to wire a custom
      // ConversationPolicy.
      ...(config.providerMode === "mock" ? { textDelivery: "always" as const } : {}),
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
    if (handle) {
      const closeReason = endRequest.reason === "completed" ? "completed" : "error";
      await handle.close(closeReason).catch(() => undefined);
    } else {
      try {
        socket.close(1011, "voice connection failed");
      } catch {
        // Raw socket teardown is best-effort before the provider handle exists.
      }
    }
    activeCalls.delete(identity.sessionRef);
    tokenStore.release(identity.sessionRef);
    if (session && runtime) await runtime.endSession(session.id, endRequest).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const memoryConfigured = await createConfiguredMemory(memory);
  // The runtime is constructed with the configured memory directly (not
  // via `Object.assign`, which is a no-op for class instances). The
  // `memory` module-scope reference is also updated for any code that
  // reads it (e.g., the pipeline loop's `options.memory`).
  memory = memoryConfigured.memory;
  const configured = await createConfiguredRuntime(memory);
  runtime = configured.runtime;
  stopMemoryServices = memoryConfigured.stopExternalServices;
  await runtime.start();
  const requestHandler = createVoiceRequestHandler({
    tokenStore,
    allowedOrigins: config.allowedOrigins,
    authSecret: config.authSecret,
    adminSecret: config.adminSecret,
    mintRateLimitPerMinute: config.mintRateLimitPerMinute,
    clientRoot: new URL("../public/", import.meta.url),
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
  console.log(`Provider mode: ${config.providerMode}`);
  console.log(
    "Voice mode is a separate deployable from the live-call gateway for capacity isolation.",
  );
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[voice] received ${signal}; shutting down`);
    await plane
      .stop()
      .catch((error: unknown) => console.error("[voice] gateway stop failed", error));
    if (runtime) {
      await runtime
        .stop()
        .catch((error: unknown) => console.error("[voice] runtime stop failed", error));
    }
    await stopMemoryServices().catch((error: unknown) =>
      console.error("[voice] memory services stop failed", error),
    );
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

void main();

export { WEB_CLIENT_AUDIO_CLOSE_CODES };
