import { createHmac } from "node:crypto";
import { request as httpRequest } from "node:http";
import { createConnection } from "node:net";

import { createNodeMediaPlane, type NodeMediaPlane } from "@tvic/runtime";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { authorizeStreamConnection, createTwimlRequestHandler } from "../src/gateway.js";
import {
  createInMemoryTwimlReplayStore,
  createStreamTokenStore,
  type CallIdentity,
  type StreamTokenReservation,
  type StreamTokenStore,
  type TwimlReplayStore,
} from "../src/security.js";

const AUTH_TOKEN = "test-auth-token";
const PUBLIC_HOST = "gateway.test";
const TWIML_PATH = "/twiml";
const MEDIA_PATH = "/media/:callId";

interface Harness {
  readonly plane: NodeMediaPlane;
  readonly port: number;
  readonly tokenStore: StreamTokenStore;
  readonly authorized: { identity: CallIdentity; callId: string }[];
}

let planes: NodeMediaPlane[] = [];

afterEach(async () => {
  await Promise.all(planes.map((plane) => plane.stop()));
  planes = [];
});

async function startGateway(
  options: {
    ttlMs?: number;
    authToken?: string;
    now?: () => number;
    afterReserve?: (reservation: StreamTokenReservation, signal: AbortSignal) => Promise<void>;
    onUpgradeAborted?: () => void;
  } = {},
): Promise<Harness> {
  const tokenStore = createStreamTokenStore("stream-secret", options.ttlMs ?? 60_000, options.now);
  const replayStore = createInMemoryTwimlReplayStore(options.now);
  const authorized: { identity: CallIdentity; callId: string }[] = [];
  const plane = createNodeMediaPlane<StreamTokenReservation>({
    host: "127.0.0.1",
    port: 0,
    path: MEDIA_PATH,
    onRequest: createTwimlRequestHandler({
      tokenStore,
      replayStore,
      twilioAuthToken:
        options.authToken === undefined ? AUTH_TOKEN : options.authToken || undefined,
      allowUnauthenticatedTwiml: options.authToken === "",
      replayTtlMs: options.ttlMs ?? 60_000,
      publicHost: PUBLIC_HOST,
      twimlPath: TWIML_PATH,
      mediaPath: MEDIA_PATH,
      maxBodyBytes: 1024,
    }),
    async authorizeUpgrade(_request, url, params, signal) {
      const reservation = authorizeStreamConnection(
        tokenStore,
        params.callId,
        url.searchParams.get("token"),
        url.searchParams.get("exp"),
      );
      if (!reservation) {
        return { ok: false, statusCode: 401 };
      }
      await options.afterReserve?.(reservation, signal);
      return { ok: true, context: reservation };
    },
    onUpgradeAborted(reservation) {
      tokenStore.restore(reservation);
      options.onUpgradeAborted?.();
    },
    async onConnection({ socket, params, upgradeContext: reservation }) {
      if (!reservation) {
        socket.close(4401, "unauthorized");
        return;
      }
      const identity = tokenStore.commit(reservation);
      if (!identity) {
        socket.close(4401, "unauthorized");
        return;
      }
      if (identity.replayKey) await replayStore.markConsumed(identity.replayKey);
      authorized.push({ identity, callId: params.callId ?? "" });
      socket.close(1000, "ok");
    },
  });
  await plane.start();
  planes.push(plane);
  const port = plane.address?.port ?? 0;
  return { plane, port, tokenStore, authorized };
}

function twilioSignature(fullUrl: string, params: Record<string, string>): string {
  let data = fullUrl;
  for (const key of Object.keys(params).sort()) {
    data += key + params[key];
  }
  return createHmac("sha1", AUTH_TOKEN).update(Buffer.from(data, "utf8")).digest("base64");
}

interface HttpResult {
  readonly status: number;
  readonly body: string;
}

function postTwiml(
  port: number,
  params: Record<string, string>,
  options: { signature?: string | null; path?: string; signal?: AbortSignal } = {},
): Promise<HttpResult> {
  const payload = new URLSearchParams(params).toString();
  const path = options.path ?? TWIML_PATH;
  const fullUrl = `https://${PUBLIC_HOST}${path}`;
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    host: PUBLIC_HOST,
    "content-length": String(Buffer.byteLength(payload)),
  };
  const signature =
    options.signature === undefined ? twilioSignature(fullUrl, params) : options.signature;
  if (signature !== null) {
    headers["x-twilio-signature"] = signature;
  }
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

function parseStreamUrl(twiml: string): { callId: string; token: string; exp: string } {
  const match = twiml.match(/url="wss:\/\/[^/]+\/media\/([^?]+)\?token=([^&]+)&amp;exp=([^"]+)"/);
  if (!match) {
    throw new Error(`no stream url in twiml: ${twiml}`);
  }
  return { callId: match[1]!, token: match[2]!, exp: match[3]! };
}

/**
 * Opens a WS to the media path. Authorization happens during the HTTP upgrade;
 * unauthorized requests never reach the connection handler.
 */
function connect(port: number, callId: string, query: string): Promise<"open" | "closed"> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/media/${callId}?${query}`);
    ws.on("error", () => undefined);
    ws.on("close", (code) => resolve(code === 1000 ? "open" : "closed"));
  });
}

describe("live-call ingress security", () => {
  const params = {
    From: "+15551234567",
    To: "+15557654321",
    CallSid: "CA123",
    AccountSid: "AC999",
  };

  it("issues a token for a correctly signed /twiml request and binds the caller identity", async () => {
    const gw = await startGateway();
    const res = await postTwiml(gw.port, params);
    expect(res.status).toBe(200);

    const { callId, token, exp } = parseStreamUrl(res.body);
    expect(await connect(gw.port, callId, `token=${token}&exp=${exp}`)).toBe("open");
    expect(gw.authorized).toHaveLength(1);
    expect(gw.authorized[0]?.identity).toMatchObject({
      from: params.From,
      to: params.To,
      twilioCallSid: params.CallSid,
      accountSid: params.AccountSid,
    });
    expect(gw.authorized[0]?.identity.replayKey).toMatch(/^initial-twiml:[0-9a-f]{64}$/);
  });

  it("rejects an invalid or missing Twilio signature with 403", async () => {
    const gw = await startGateway();
    expect((await postTwiml(gw.port, params, { signature: "bogus" })).status).toBe(403);
    expect((await postTwiml(gw.port, params, { signature: null })).status).toBe(403);
  });

  it("rejects a signed webhook with incomplete caller identity before issuing a token", async () => {
    const gw = await startGateway();
    const { From: _from, ...withoutFrom } = params;
    const { To: _to, ...withoutTo } = params;
    const { CallSid: _callSid, ...withoutCallSid } = params;

    for (const incomplete of [withoutFrom, withoutTo, withoutCallSid]) {
      expect((await postTwiml(gw.port, incomplete)).status).toBe(400);
    }
    expect(gw.authorized).toHaveLength(0);
  });

  it("includes the request query string in Twilio signature verification", async () => {
    const gw = await startGateway();
    const path = `${TWIML_PATH}?attempt=2`;
    const signature = twilioSignature(`https://${PUBLIC_HOST}${path}`, params);
    const res = await postTwiml(gw.port, params, { path, signature });
    expect(res.status).toBe(200);
  });

  it("rejects an oversized body before buffering it", async () => {
    const gw = await startGateway();
    // Real body over the 1 KiB cap (declared content-length is honoured before reading).
    const res = await postTwiml(gw.port, { ...params, Filler: "x".repeat(2000) });
    expect(res.status).toBe(413);
  });

  it("consumes a stream token exactly once (replay rejected)", async () => {
    const gw = await startGateway();
    const { callId, token, exp } = parseStreamUrl((await postTwiml(gw.port, params)).body);
    expect(await connect(gw.port, callId, `token=${token}&exp=${exp}`)).toBe("open");
    expect(await connect(gw.port, callId, `token=${token}&exp=${exp}`)).toBe("closed");
  });

  it("restores the token when an authorized WebSocket handshake is rejected", async () => {
    let resolveUpgradeAborted: () => void = () => undefined;
    const upgradeAborted = new Promise<void>((resolve) => {
      resolveUpgradeAborted = resolve;
    });
    const gw = await startGateway({
      onUpgradeAborted: resolveUpgradeAborted,
    });
    const { callId, token, exp } = parseStreamUrl((await postTwiml(gw.port, params)).body);
    const socket = createConnection({ host: "127.0.0.1", port: gw.port });
    socket.on("error", () => undefined);
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    let response = "";
    const handshakeRejected = new Promise<void>((resolve) => {
      socket.on("data", (chunk) => {
        response += chunk.toString("utf8");
        if (response.includes("\r\n\r\n")) resolve();
      });
    });
    socket.write(
      [
        `GET /media/${callId}?token=${token}&exp=${exp} HTTP/1.1`,
        `Host: ${PUBLIC_HOST}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: invalid",
        "",
        "",
      ].join("\r\n"),
    );
    await handshakeRejected;
    expect(response).toContain("HTTP/1.1 400");
    await upgradeAborted;

    expect(await connect(gw.port, callId, `token=${token}&exp=${exp}`)).toBe("open");
    expect(gw.authorized).toHaveLength(1);
  });

  it("returns the original TwiML for an authenticated webhook retry without minting a token", async () => {
    const gw = await startGateway();
    const first = await postTwiml(gw.port, params);
    const retry = await postTwiml(gw.port, params);

    expect(first.status).toBe(200);
    expect(retry).toEqual(first);
    const issued = parseStreamUrl(first.body);
    expect(await connect(gw.port, issued.callId, `token=${issued.token}&exp=${issued.exp}`)).toBe(
      "open",
    );
    // Once the one-use token is consumed, the HTTP retry is rejected instead of
    // returning a stale response or minting a replacement token.
    expect((await postTwiml(gw.port, params)).status).toBe(409);
  });

  it("rejects a conflicting signed payload for an existing Twilio call", async () => {
    const gw = await startGateway();
    expect((await postTwiml(gw.port, params)).status).toBe(200);
    const conflicting = await postTwiml(gw.port, { ...params, From: "+15550000000" });
    expect(conflicting.status).toBe(409);
  });

  it("serializes concurrent duplicate deliveries behind one replay reservation", async () => {
    const gw = await startGateway();
    const results = await Promise.all([
      postTwiml(gw.port, params),
      postTwiml(gw.port, params),
      postTwiml(gw.port, params),
    ]);
    expect(results.every((result) => result.status === 200)).toBe(true);
    expect(new Set(results.map((result) => result.body)).size).toBe(1);
  });

  it("aborts a replay claim acquired after HTTP shutdown without issuing a token", async () => {
    let resolveAcquireStarted: () => void = () => undefined;
    const acquireStarted = new Promise<void>((resolve) => {
      resolveAcquireStarted = resolve;
    });
    let resolveClaim: (claim: {
      readonly kind: "owner";
      readonly complete: (response: string) => Promise<void>;
      readonly abort: () => Promise<void>;
    }) => void = () => undefined;
    const claimGate = new Promise<{
      readonly kind: "owner";
      readonly complete: (response: string) => Promise<void>;
      readonly abort: () => Promise<void>;
    }>((resolve) => {
      resolveClaim = resolve;
    });
    let resolveClaimAborted: () => void = () => undefined;
    const claimAborted = new Promise<void>((resolve) => {
      resolveClaimAborted = resolve;
    });
    const replayStore: TwimlReplayStore = {
      scope: "process",
      async acquire() {
        resolveAcquireStarted();
        return claimGate;
      },
      async markConsumed() {},
      prune() {},
    };
    const actualTokenStore = createStreamTokenStore("stream-secret", 60_000);
    let issues = 0;
    const tokenStore: StreamTokenStore = {
      issue(identity) {
        issues += 1;
        return actualTokenStore.issue(identity);
      },
      reserve: (...args) => actualTokenStore.reserve(...args),
      commit: (...args) => actualTokenStore.commit(...args),
      restore: (...args) => actualTokenStore.restore(...args),
      release: (callId) => actualTokenStore.release(callId),
      prune: () => actualTokenStore.prune(),
    };
    const plane = createNodeMediaPlane({
      host: "127.0.0.1",
      port: 0,
      path: MEDIA_PATH,
      onRequest: createTwimlRequestHandler({
        tokenStore,
        replayStore,
        twilioAuthToken: AUTH_TOKEN,
        allowUnauthenticatedTwiml: false,
        replayTtlMs: 60_000,
        publicHost: PUBLIC_HOST,
        twimlPath: TWIML_PATH,
        mediaPath: MEDIA_PATH,
        maxBodyBytes: 1024,
      }),
      onConnection() {},
    });
    await plane.start();
    planes.push(plane);
    const request = postTwiml(plane.address?.port ?? 0, params).catch(() => undefined);
    await acquireStarted;

    await plane.stop();
    resolveClaim({
      kind: "owner",
      async complete() {},
      async abort() {
        resolveClaimAborted();
      },
    });
    await claimAborted;
    await request;
    expect(issues).toBe(0);
  });

  it("passes HTTP shutdown cancellation into replay acquisition", async () => {
    let resolveAcquireStarted: () => void = () => undefined;
    const acquireStarted = new Promise<void>((resolve) => {
      resolveAcquireStarted = resolve;
    });
    let resolveAcquireAborted: () => void = () => undefined;
    const acquireAborted = new Promise<void>((resolve) => {
      resolveAcquireAborted = resolve;
    });
    let acquiredSignal: AbortSignal | undefined;
    const replayStore: TwimlReplayStore = {
      scope: "process",
      acquire(_key, _hash, _ttlMs, signal) {
        acquiredSignal = signal;
        resolveAcquireStarted();
        return new Promise((resolve) => {
          signal?.addEventListener(
            "abort",
            () => {
              resolve({ kind: "busy" });
              resolveAcquireAborted();
            },
            { once: true },
          );
        });
      },
      async markConsumed() {},
      prune() {},
    };
    const actualTokenStore = createStreamTokenStore("stream-secret", 60_000);
    let issues = 0;
    const tokenStore: StreamTokenStore = {
      issue(identity) {
        issues += 1;
        return actualTokenStore.issue(identity);
      },
      reserve: (...args) => actualTokenStore.reserve(...args),
      commit: (...args) => actualTokenStore.commit(...args),
      restore: (...args) => actualTokenStore.restore(...args),
      release: (callId) => actualTokenStore.release(callId),
      prune: () => actualTokenStore.prune(),
    };
    const plane = createNodeMediaPlane({
      host: "127.0.0.1",
      port: 0,
      path: MEDIA_PATH,
      onRequest: createTwimlRequestHandler({
        tokenStore,
        replayStore,
        twilioAuthToken: AUTH_TOKEN,
        allowUnauthenticatedTwiml: false,
        replayTtlMs: 60_000,
        publicHost: PUBLIC_HOST,
        twimlPath: TWIML_PATH,
        mediaPath: MEDIA_PATH,
        maxBodyBytes: 1024,
      }),
      onConnection() {},
    });
    await plane.start();
    planes.push(plane);
    const request = postTwiml(plane.address?.port ?? 0, params).catch(() => undefined);
    await acquireStarted;

    await plane.stop();
    const stoppedWaiting = await Promise.race([
      acquireAborted.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    await request;

    expect(stoppedWaiting).toBe(true);
    expect(acquiredSignal?.aborted).toBe(true);
    expect(issues).toBe(0);
  });

  it("keeps a published replay token valid when its owner request disconnects", async () => {
    let resolveReplayPublished: () => void = () => undefined;
    const replayPublished = new Promise<void>((resolve) => {
      resolveReplayPublished = resolve;
    });
    let finishCompletionAck: () => void = () => undefined;
    const completionAckGate = new Promise<void>((resolve) => {
      finishCompletionAck = resolve;
    });
    let resolveOwnerAborted: () => void = () => undefined;
    const ownerAborted = new Promise<void>((resolve) => {
      resolveOwnerAborted = resolve;
    });
    const actualReplayStore = createInMemoryTwimlReplayStore();
    let replayRequest: { readonly key: string; readonly hash: string } | undefined;
    const actualTokenStore = createStreamTokenStore("stream-secret", 60_000);
    const tokenStore: StreamTokenStore = {
      issue(identity) {
        return actualTokenStore.issue(identity);
      },
      reserve: (...args) => actualTokenStore.reserve(...args),
      commit: (...args) => actualTokenStore.commit(...args),
      restore: (...args) => actualTokenStore.restore(...args),
      release: (callId) => actualTokenStore.release(callId),
      prune: () => actualTokenStore.prune(),
    };
    const replayStore: TwimlReplayStore = {
      scope: actualReplayStore.scope,
      async acquire(key, hash, ttlMs) {
        replayRequest = { key, hash };
        const claim = await actualReplayStore.acquire(key, hash, ttlMs);
        if (claim.kind !== "owner") return claim;
        return {
          kind: "owner",
          async complete(response) {
            await claim.complete(response);
            resolveReplayPublished();
            await completionAckGate;
          },
          abort: claim.abort,
        };
      },
      markConsumed: (key) => actualReplayStore.markConsumed(key),
      prune() {
        actualReplayStore.prune();
      },
    };
    const onTwimlRequest = createTwimlRequestHandler({
      tokenStore,
      replayStore,
      twilioAuthToken: AUTH_TOKEN,
      allowUnauthenticatedTwiml: false,
      replayTtlMs: 60_000,
      publicHost: PUBLIC_HOST,
      twimlPath: TWIML_PATH,
      mediaPath: MEDIA_PATH,
      maxBodyBytes: 1024,
    });
    const plane = createNodeMediaPlane({
      host: "127.0.0.1",
      port: 0,
      path: MEDIA_PATH,
      onRequest(request, response, signal) {
        signal.addEventListener("abort", resolveOwnerAborted, { once: true });
        return onTwimlRequest(request, response, signal);
      },
      onConnection() {},
    });
    await plane.start();
    planes.push(plane);
    const ownerController = new AbortController();
    const ownerRequest = postTwiml(plane.address?.port ?? 0, params, {
      signal: ownerController.signal,
    }).then(
      () => false,
      () => true,
    );
    await replayPublished;
    const retry = await postTwiml(plane.address?.port ?? 0, params);
    ownerController.abort();
    await ownerAborted;
    finishCompletionAck();
    await expect(ownerRequest).resolves.toBe(true);

    if (!replayRequest) throw new Error("the TwiML request did not acquire a replay key");
    expect(retry.status).toBe(200);
    const replayedToken = parseStreamUrl(retry.body);
    const reservation = tokenStore.reserve(
      replayedToken.callId,
      replayedToken.token,
      replayedToken.exp,
    );
    expect(reservation?.identity).toMatchObject({
      from: params.From,
      to: params.To,
      twilioCallSid: params.CallSid,
    });
    if (!reservation) throw new Error("replayed TwiML token could not be reserved");
    expect(tokenStore.commit(reservation)).toMatchObject({
      from: params.From,
      to: params.To,
      twilioCallSid: params.CallSid,
    });
    await expect(
      replayStore.acquire(replayRequest.key, replayRequest.hash, 60_000),
    ).resolves.toEqual({ kind: "replayed", response: retry.body });
    await replayStore.markConsumed(replayRequest.key);
    await expect(
      replayStore.acquire(replayRequest.key, replayRequest.hash, 60_000),
    ).resolves.toEqual({ kind: "consumed" });
  });

  it("rejects a webhook without the identifiers required for replay protection", async () => {
    const gw = await startGateway();
    const result = await postTwiml(gw.port, { From: params.From, To: params.To });
    expect(result.status).toBe(400);
    expect(result.body).toContain("AccountSid and CallSid are required");
  });

  it("fails closed when authentication is not configured and development mode is not enabled", async () => {
    const tokenStore = createStreamTokenStore("stream-secret", 60_000);
    const replayStore = createInMemoryTwimlReplayStore();
    const plane = createNodeMediaPlane({
      host: "127.0.0.1",
      port: 0,
      path: MEDIA_PATH,
      onRequest: createTwimlRequestHandler({
        tokenStore,
        replayStore,
        twilioAuthToken: undefined,
        allowUnauthenticatedTwiml: false,
        replayTtlMs: 60_000,
        publicHost: PUBLIC_HOST,
        twimlPath: TWIML_PATH,
        mediaPath: MEDIA_PATH,
        maxBodyBytes: 1024,
      }),
      onConnection() {
        throw new Error("unauthenticated request must not reach the media plane");
      },
    });
    await plane.start();
    planes.push(plane);
    const result = await postTwiml(plane.address?.port ?? 0, params);
    expect(result.status).toBe(503);
  });

  it("rejects expired tokens", async () => {
    let nowMs = 0;
    const gw = await startGateway({ ttlMs: 1, now: () => nowMs });
    const { callId, token, exp } = parseStreamUrl((await postTwiml(gw.port, params)).body);
    nowMs = 2;
    expect(await connect(gw.port, callId, `token=${token}&exp=${exp}`)).toBe("closed");
  });

  it("rejects a wrong callId, tampered exp, or missing token", async () => {
    const gw = await startGateway();
    const { callId, token, exp } = parseStreamUrl((await postTwiml(gw.port, params)).body);
    expect(await connect(gw.port, "call_wrong", `token=${token}&exp=${exp}`)).toBe("closed");
    expect(await connect(gw.port, callId, `token=${token}&exp=${Number(exp) + 1}`)).toBe("closed");
    expect(await connect(gw.port, callId, `exp=${exp}`)).toBe("closed");
  });

  it("handles concurrent calls with independent tokens", async () => {
    const gw = await startGateway();
    const a = parseStreamUrl((await postTwiml(gw.port, { ...params, CallSid: "CA_A" })).body);
    const b = parseStreamUrl((await postTwiml(gw.port, { ...params, CallSid: "CA_B" })).body);
    expect(a.callId).not.toBe(b.callId);
    expect(await connect(gw.port, a.callId, `token=${a.token}&exp=${a.exp}`)).toBe("open");
    expect(await connect(gw.port, b.callId, `token=${b.token}&exp=${b.exp}`)).toBe("open");
    expect(gw.authorized.map((entry) => entry.identity.twilioCallSid).sort()).toEqual([
      "CA_A",
      "CA_B",
    ]);
  });
});
