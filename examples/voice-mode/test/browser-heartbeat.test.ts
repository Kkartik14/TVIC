import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createWebClientAudioProvider,
  createNodeMediaPlane,
  type CallId,
  type NodeMediaPlane,
  type SessionId,
} from "voice-runtime";

import { createVoiceRequestHandler, createVoiceUpgradeAuthorizer } from "../src/gateway.js";
import { TvicVoiceClient } from "../public/voice-client.js";
import {
  createAppUserToken,
  createVoiceSessionStore,
  type VoiceSessionIdentity,
} from "../src/security.js";

describe("browser heartbeat integration", () => {
  let plane: NodeMediaPlane<VoiceSessionIdentity> | undefined;

  afterEach(async () => {
    await plane?.stop();
    plane = undefined;
    vi.unstubAllGlobals();
  });

  it("matches the advertised interval for a valid short-timeout configuration", async () => {
    const provider = createWebClientAudioProvider({
      heartbeatIntervalMs: 1_500,
      heartbeatTimeoutMs: 1_700,
    });
    const tokenStore = createVoiceSessionStore({
      tokenSecret: "session-secret",
      safetyIdentifierSecret: "safety-secret",
      ttlMs: 60_000,
      concurrentSessionCap: 1,
    });
    plane = createNodeMediaPlane<VoiceSessionIdentity>({
      port: 0,
      path: "/voice/:sessionRef",
      onRequest: createVoiceRequestHandler({
        tokenStore,
        allowedOrigins: ["https://app.example"],
        authSecret: "app-secret",
        adminSecret: "admin-secret",
      }),
      authorizeUpgrade: createVoiceUpgradeAuthorizer({
        tokenStore,
        allowedOrigins: ["https://app.example"],
      }),
      async onConnection({ socket, upgradeContext }) {
        if (!upgradeContext) return;
        await provider.acceptWebSocket(
          socket,
          upgradeContext.sessionRef as CallId,
          `session_${upgradeContext.sessionRef}` as SessionId,
          { expectedMode: upgradeContext.mode },
        );
      },
    });
    await plane.start();

    vi.stubGlobal("WebSocket", WebSocket);
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: async () => createMediaStream() },
    });
    vi.stubGlobal("AudioContext", TestAudioContext);
    vi.stubGlobal("AudioWorkletNode", TestAudioWorkletNode);

    const client = new TvicVoiceClient({
      gatewayUrl: `http://127.0.0.1:${plane.address?.port}`,
      appToken: createAppUserToken("heartbeat-user", "app-secret"),
      mode: "continuous",
    });
    let pongCount = 0;
    client.addEventListener("pong", () => {
      pongCount += 1;
    });
    const ready = waitForClientEvent(client, "ready", 2_000);
    try {
      await client.connect();
      await ready;
      const pong = waitForClientEvent(client, "pong", 2_500);
      await pong;
      await delay(2_200);

      expect(pongCount).toBeGreaterThanOrEqual(2);
      expect(client.connected).toBe(true);
    } finally {
      await client.close();
    }
  });
});

function waitForClientEvent(
  client: TvicVoiceClient,
  type: "ready" | "pong",
  timeoutMs: number,
): Promise<Event> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.removeEventListener(type, onEvent);
      reject(new Error(`Timed out waiting for browser ${type} event`));
    }, timeoutMs);
    const onEvent = (event: Event): void => {
      clearTimeout(timer);
      resolve(event);
    };
    client.addEventListener(type, onEvent, { once: true });
  });
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function createMediaStream() {
  return { getTracks: () => [{ stop() {} }] };
}

class TestAudioContext {
  readonly destination = {};
  readonly audioWorklet = { addModule: async () => undefined };

  async resume(): Promise<void> {}

  createMediaStreamSource(_stream: ReturnType<typeof createMediaStream>) {
    return { connect() {}, disconnect() {} };
  }

  createGain() {
    return { gain: { value: 1 }, connect() {}, disconnect() {} };
  }

  async close(): Promise<void> {}
}

class TestAudioWorkletNode {
  readonly port: { onmessage: ((event: { readonly data: unknown }) => void) | null } = {
    onmessage: null,
  };

  constructor(_context: TestAudioContext, _name: string) {}

  connect(): void {}

  disconnect(): void {}
}
