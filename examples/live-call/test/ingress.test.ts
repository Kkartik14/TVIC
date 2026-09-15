import { createHmac } from "node:crypto";
import { request as httpRequest } from "node:http";

import { createNodeMediaPlane, type NodeMediaPlane } from "@tvic/runtime";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { authorizeStreamConnection, createTwimlRequestHandler } from "../src/gateway.js";
import {
  createStreamTokenStore,
  type CallIdentity,
  type StreamTokenStore,
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
    replayWindowMs?: number;
  } = {},
): Promise<Harness> {
  const tokenStore = createStreamTokenStore("stream-secret", options.ttlMs ?? 60_000, options.now);
  const authorized: { identity: CallIdentity; callId: string }[] = [];
  const plane = createNodeMediaPlane<CallIdentity>({
    host: "127.0.0.1",
    port: 0,
    path: MEDIA_PATH,
    onRequest: createTwimlRequestHandler({
      tokenStore,
      twilioAuthToken:
        options.authToken === undefined ? AUTH_TOKEN : options.authToken || undefined,
      publicHost: PUBLIC_HOST,
      twimlPath: TWIML_PATH,
      mediaPath: MEDIA_PATH,
      maxBodyBytes: 1024,
      ...(options.replayWindowMs ? { replayWindowMs: options.replayWindowMs } : {}),
      ...(options.now ? { now: options.now } : {}),
    }),
    authorizeUpgrade(_request, url, params) {
      const identity = authorizeStreamConnection(
        tokenStore,
        params.callId,
        url.searchParams.get("token"),
        url.searchParams.get("exp"),
      );
      if (!identity) {
        return { ok: false, statusCode: 401 };
      }
      return { ok: true, context: identity };
    },
    onConnection({ socket, params, upgradeContext: identity }) {
      if (!identity) {
        socket.close(4401, "unauthorized");
        return;
      }
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
  options: { signature?: string | null; path?: string } = {},
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
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "POST", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
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
    expect(gw.authorized[0]?.identity).toEqual({
      from: params.From,
      to: params.To,
      twilioCallSid: params.CallSid,
      accountSid: params.AccountSid,
    });
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

  it("rejects a duplicate signed webhook for the same Twilio CallSid", async () => {
    const gw = await startGateway();
    const first = await postTwiml(gw.port, params);
    const duplicate = await postTwiml(gw.port, params);
    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(409);
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
