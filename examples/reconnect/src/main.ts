/**
 * Worked example: cross-process reconnect.
 *
 * The runtime exposes `SessionActivator` — a seam the customer implements
 * to provide a fresh transport handle for a reattached session. The
 * runtime does NOT ship a token registry; the customer owns the token
 * format (JWT, opaque, signed, etc.), the storage (Redis, Postgres,
 * in-memory), the TTL, and the IdP integration.
 *
 * This example shows the minimum shape:
 *   1. The customer's gateway mints a signed token at call start.
 *   2. The customer's gateway stores the token → sessionId mapping.
 *   3. On reconnect, the customer's gateway verifies the token, looks
 *      up the sessionId, and calls `runtime.attachSession(agent, sessionId)`.
 *   4. The runtime's existing `SessionActivator` provides a fresh
 *      transport handle for the reattached session.
 *
 * The example is runnable as a script. To make it production-grade,
 * replace the in-memory `tokenStore` with your IdP, your signed JWT
 * library, and your database.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { createInMemoryMemory } from "@tvic/dal";
import { createRuntime, defineAgent } from "@tvic/runtime";
import {
  PCM16_16K_MONO,
  type Agent,
  type Call,
  type MediaTransport,
  type RingingCall,
  type SessionId,
  type UserId,
} from "@tvic/core";

// ============================================================================
// Customer-owned: token mint + verify + storage
// ============================================================================

interface Token {
  readonly token: string;
  readonly userId: UserId;
  readonly sessionId: SessionId;
  readonly expiresAtMs: number;
}

class TokenStore {
  private readonly tokens = new Map<string, Token>();
  private readonly secret: string;
  private readonly ttlMs: number;

  constructor(secret: string, ttlMs: number) {
    this.secret = secret;
    this.ttlMs = ttlMs;
  }

  mint(userId: UserId, sessionId: SessionId): Token {
    const expiresAtMs = Date.now() + this.ttlMs;
    const payload = `${userId}:${sessionId}:${expiresAtMs}`;
    const signature = createHmac("sha256", this.secret).update(payload).digest("hex");
    const token = `${Buffer.from(payload).toString("base64url")}.${signature}`;
    const entry: Token = { token, userId, sessionId, expiresAtMs };
    this.tokens.set(token, entry);
    return entry;
  }

  verify(token: string): Token | null {
    // The token shape is `<base64url(payload)>.<hex(signature)>`. The
    // payload is `${userId}:${sessionId}:${expiresAtMs}`. The signature
    // is HMAC-SHA256(secret, payload) in hex. This is a real
    // cryptographic verify — `timingSafeEqual` prevents timing attacks.
    const dotIndex = token.indexOf(".");
    if (dotIndex < 0) return null;
    const encodedPayload = token.slice(0, dotIndex);
    const providedSignatureHex = token.slice(dotIndex + 1);
    if (providedSignatureHex.length !== 64) return null;
    const payload = Buffer.from(encodedPayload, "base64url").toString();
    const expectedSignature = createHmac("sha256", this.secret).update(payload).digest();
    const providedSignature = Buffer.from(providedSignatureHex, "hex");
    if (
      providedSignature.length !== expectedSignature.length ||
      !timingSafeEqual(providedSignature, expectedSignature)
    ) {
      return null;
    }
    // Signature is valid; pull the entry from the store. The store is
    // the source of truth for the userId/sessionId binding; the signature
    // proves the token wasn't tampered with. Tokens whose store entry
    // has expired are rejected.
    const entry = this.tokens.get(token);
    if (!entry) return null;
    if (entry.expiresAtMs <= Date.now()) {
      this.tokens.delete(token);
      return null;
    }
    return entry;
  }
}

// ============================================================================
// Customer-owned: the gateway
// ============================================================================

interface GatewayOpts {
  readonly tokenSecret: string;
  readonly tokenTtlMs: number;
}

function makeGateway(opts: GatewayOpts) {
  const store = new TokenStore(opts.tokenSecret, opts.tokenTtlMs);
  return {
    issueToken(userId: UserId, sessionId: SessionId): Token {
      return store.mint(userId, sessionId);
    },
    resumeSession(token: string): { userId: UserId; sessionId: SessionId } | null {
      const entry = store.verify(token);
      if (!entry) return null;
      return { userId: entry.userId, sessionId: entry.sessionId };
    },
  };
}

// ============================================================================
// Customer-owned: the agent
// ============================================================================

function buildAgent(): Agent {
  return defineAgent({
    id: "reconnect-demo-agent",
    name: "Reconnect Demo Agent",
    instructions:
      "You are a customer service agent. The customer reconnects via a signed token; the runtime resumes the session.",
    tools: [],
    audioPolicy: { input: PCM16_16K_MONO, output: PCM16_16K_MONO },
    memoryPolicy: { enabled: true, scopes: ["user", "session"] },
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
  });
}

const TEST_PROVIDER_CAPABILITIES = {
  streaming: { input: true, output: true, native: true },
  cancellation: { request: true, output: true, buffer: true, truncation: true },
  transports: ["websocket" as const],
  audio: { input: [PCM16_16K_MONO], output: [PCM16_16K_MONO] },
  tools: { functionCalling: true, parallelCalls: true },
  playout: { clearBuffer: true, acknowledgement: true, position: true },
};

// ============================================================================
// Demo
// ============================================================================

async function main(): Promise<void> {
  const secret = "demo-secret-do-not-use-in-prod";
  const gateway = makeGateway({ tokenSecret: secret, tokenTtlMs: 60_000 });

  const runtime = createRuntime({ memory: createInMemoryMemory() });
  await runtime.start();
  const agent = buildAgent();
  const call = buildDemoCall("reconnect-1", "user-1" as UserId);

  // Step 1: customer calls for the first time. The customer's gateway mints
  // a signed token, returns it to the client (e.g., as a WebSocket bearer).
  console.log("=== Call 1: agent greets, gateway mints token ===\n");
  const a1 = await runtime.startAttachedSession(agent, {
    channel: "web_audio",
    call,
    memoryUserId: "user-1" as UserId,
  });
  const token1 = gateway.issueToken("user-1" as UserId, a1.session.id);
  console.log(`Issued token: ${token1.token.slice(0, 32)}...`);
  console.log(`Session id: ${a1.session.id}`);
  await a1.detach();

  // Step 2: customer's network blips. The same caller reconnects with the
  // same token. The customer's gateway verifies the token, looks up the
  // sessionId, and calls runtime.attachSession.
  console.log("\n=== Call 2: caller reconnects with token, runtime resumes session ===\n");
  const resolved = gateway.resumeSession(token1.token);
  if (!resolved) {
    console.log("Token invalid; cannot resume.");
    await runtime.stop();
    return;
  }
  console.log(`Resumed session: ${resolved.sessionId}`);
  const a2 = await runtime.attachSession(agent, resolved.sessionId, {});
  console.log(`Reattach succeeded: ${a2.session.id === resolved.sessionId}`);
  await a2.detach();

  await runtime.stop();
  console.log("\nOK: reconnect demo finished cleanly.");
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

main().catch((error: unknown) => {
  console.error("FATAL:", error);
  process.exit(1);
});
