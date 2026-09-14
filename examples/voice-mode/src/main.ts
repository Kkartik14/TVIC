import {
  createInMemoryMemory,
  createCartesiaTtsProvider,
  createDeepgramSttProvider,
  createNodeMediaPlane,
  createOpenAiResponsesLlmProvider,
  createVoiceAgent,
  createWebClientAudioProvider,
  nowTimestamp,
  PCM16_16K_MONO,
  WEB_CLIENT_AUDIO_CLOSE_CODES,
  type Call,
  type CallId,
  type ConnectionObservabilityEvent,
  type Memory,
  type RuntimeOptions,
  type VoiceAgent,
  type VoiceEvent,
} from "voice-runtime";

import { loadConfig } from "./config.js";
import { createVoiceRequestHandler, createVoiceUpgradeAuthorizer } from "./gateway.js";
import { createVoiceSessionStore, type VoiceSessionIdentity } from "./security.js";
import { createMockVoiceProviders } from "./mock-providers.js";
import { createConfiguredRuntime } from "./durable-runtime.js";

import { createConfiguredMemory } from "./memory-runtime.js";

const config = loadConfig();
let agent: VoiceAgent | undefined;
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

const tokenStore = createVoiceSessionStore({
  tokenSecret: config.streamTokenSecret,
  safetyIdentifierSecret: config.safetyIdentifierSecret,
  ttlMs: config.streamTokenTtlMs,
  concurrentSessionCap: config.concurrentSessionCap,
  maxSessionDurationMs: config.maxSessionDurationMs,
});
const activeCalls = new Map<string, CallId>();

function createManagedAgent(runtime: RuntimeOptions): VoiceAgent {
  if (!tts) {
    throw new Error(
      "Voice mode requires TTS. Set CARTESIA_API_KEY and CARTESIA_VOICE_ID, or use PROVIDER_MODE=mock.",
    );
  }
  return createVoiceAgent({
    id: "voice-mode-agent",
    name: "Voice Mode Agent",
    prompt: "Be concise, useful, and conversational. Ask one clarification at a time.",
    providers: { telephony, stt, llm, tts },
    audio: { input: PCM16_16K_MONO, output: PCM16_16K_MONO },
    memoryPolicy: { enabled: true, scopes: ["session", "user"] as const },
    interruptionPolicy: { mode: "graceful", minSpeechMs: 200, trimOutputOnInterrupt: true },
    runtime,
  });
}

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
  activeCalls.set(identity.sessionRef, callId);
  if (!agent) {
    socket.close(1011, "voice agent is not ready");
    activeCalls.delete(identity.sessionRef);
    tokenStore.release(identity.sessionRef);
    return;
  }
  let handleCreated = false;
  try {
    const session = await agent.start({
      channel: "web_audio",
      call: buildCall(identity),
      memoryUserId: identity.memoryUserId,
      metadata: { voiceMode: identity.mode },
      safetyIdentifier: identity.safetyIdentifier,
      ...(config.providerMode === "mock" ? { textDelivery: "always" as const } : {}),
      callHandle: async ({ sessionId }) => {
        const accepted = await telephony.acceptWebSocket(socket, callId, sessionId, {
          expectedMode: identity.mode,
        });
        handleCreated = true;
        return accepted;
      },
    });
    console.log(`[voice ${callId}] connected (session ${session.sessionId})`);
    const events = observeEvents(session.run, callId);
    void events.catch(() => undefined);
    const result = await session.run;
    await events;
    console.log(
      `[voice ${callId}] ended: ${result.turnsHandled} turns, ${result.interruptions} interruptions`,
    );
  } catch (error) {
    console.error(`[voice ${callId}] failed:`, error);
  } finally {
    if (!handleCreated) {
      try {
        socket.close(1011, "voice connection failed");
      } catch {
        // Raw socket teardown is best-effort before the provider handle is accepted.
      }
    }
    activeCalls.delete(identity.sessionRef);
    tokenStore.release(identity.sessionRef);
  }
}

async function observeEvents(run: AsyncIterable<VoiceEvent>, callId: string): Promise<void> {
  try {
    for await (const event of run) {
      if (event.kind === "error" || event.kind === "call_ended") {
        console.log(`[voice ${callId}] event`, event);
      }
    }
  } catch {
    // The result Promise is the authoritative failure surface. The observer
    // still drains the ordered event prefix when a run rejects.
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
  agent = createManagedAgent(configured.options);
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
    healthCheck: () => agent!.healthCheck(),
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
    await agent
      ?.stop()
      .catch((error: unknown) => console.error("[voice] runtime stop failed", error));
    await stopMemoryServices().catch((error: unknown) =>
      console.error("[voice] memory services stop failed", error),
    );
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

void main();

export { WEB_CLIENT_AUDIO_CLOSE_CODES };
