import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { loadLocalEnv } from "../src/env.js";

const TERMINAL_CALL_STATUSES = new Set(["completed", "busy", "failed", "no-answer", "canceled"]);
const DEFAULT_MAX_WAIT_MS = 5 * 60_000;
const DEFAULT_POLL_MS = 3_000;

interface TwilioCallResource {
  readonly sid?: unknown;
  readonly status?: unknown;
  readonly to?: unknown;
  readonly from?: unknown;
  readonly message?: unknown;
  readonly code?: unknown;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function boundedInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/u.test(raw)) throw new Error(`${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

function validateConfig(): {
  readonly accountSid: string;
  readonly apiUsername: string;
  readonly apiPassword: string;
  readonly from: string;
  readonly to: string;
  readonly callsUrl: string;
  readonly outboundCallUrl: string;
  readonly outboundCallToken: string;
  readonly maxWaitMs: number;
  readonly pollMs: number;
} {
  const accountSid = required("TWILIO_ACCOUNT_SID");
  const apiKeySid = process.env.TWILIO_API_KEY_SID?.trim() || undefined;
  const apiKeySecret = process.env.TWILIO_API_KEY_SECRET?.trim() || undefined;
  const authToken = required("TWILIO_AUTH_TOKEN");
  const from = required("TWILIO_FROM_NUMBER");
  const to = required("TWILIO_TO_NUMBER");
  const publicHost = required("PUBLIC_HOST");
  const outboundCallToken = required("TVIC_OUTBOUND_CALL_TOKEN");

  if (!/^AC[0-9a-f]{32}$/iu.test(accountSid)) {
    throw new Error("TWILIO_ACCOUNT_SID must be an Account SID beginning with AC");
  }
  if ((apiKeySid === undefined) !== (apiKeySecret === undefined)) {
    throw new Error("Set both TWILIO_API_KEY_SID and TWILIO_API_KEY_SECRET, or leave both blank");
  }
  if (apiKeySid && !/^SK[0-9a-f]{32}$/iu.test(apiKeySid)) {
    throw new Error("TWILIO_API_KEY_SID must be an API key SID beginning with SK");
  }
  if (!/^\+[1-9]\d{7,14}$/u.test(from) || !/^\+[1-9]\d{7,14}$/u.test(to)) {
    throw new Error("TWILIO_FROM_NUMBER and TWILIO_TO_NUMBER must use E.164 format");
  }
  if (!/^[A-Za-z0-9.-]+$/u.test(publicHost)) {
    throw new Error("PUBLIC_HOST must be a hostname only, without scheme, path, or port");
  }
  if (outboundCallToken.length < 32) {
    throw new Error("TVIC_OUTBOUND_CALL_TOKEN must contain at least 32 characters");
  }

  const maxWaitMs = boundedInt("TWILIO_LIVE_MAX_WAIT_MS", DEFAULT_MAX_WAIT_MS, 30_000, 30 * 60_000);
  const pollMs = boundedInt("TWILIO_LIVE_POLL_MS", DEFAULT_POLL_MS, 1_000, 30_000);
  return {
    accountSid,
    apiUsername: apiKeySid ?? accountSid,
    apiPassword: apiKeySecret ?? authToken,
    from,
    to,
    callsUrl: `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls`,
    outboundCallUrl: `https://${publicHost}/calls/outbound`,
    outboundCallToken,
    maxWaitMs,
    pollMs,
  };
}

function authHeader(keySid: string, keySecret: string): string {
  return `Basic ${Buffer.from(`${keySid}:${keySecret}`, "utf8").toString("base64")}`;
}

async function twilioRequest(
  url: string,
  authorization: string,
  init: RequestInit = {},
): Promise<TwilioCallResource> {
  const headers = new Headers(init.headers);
  headers.set("authorization", authorization);
  headers.set("accept", "application/json");
  const response = await fetch(url, {
    ...init,
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!isRecord(payload)) {
    throw new Error(`Twilio returned HTTP ${response.status} with a non-JSON response`);
  }
  if (!response.ok) {
    const code = typeof payload.code === "number" ? ` (${payload.code})` : "";
    const message = typeof payload.message === "string" ? payload.message : "request failed";
    throw new Error(`Twilio API HTTP ${response.status}${code}: ${message}`);
  }
  return payload;
}

async function checkGateway(publicHost: string): Promise<void> {
  const response = await fetch(`https://${publicHost}/healthz`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    throw new Error(`Public gateway health check returned HTTP ${response.status}`);
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!isRecord(payload) || payload.ok !== true) {
    throw new Error("Public gateway is reachable but its health check is not ready");
  }
}

async function startCallThroughSdk(
  url: string,
  token: string,
  to: string,
): Promise<{ readonly callSid: string; readonly callId: string; readonly sessionId: string }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ to }),
    signal: AbortSignal.timeout(45_000),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok || !isRecord(payload)) {
    throw new Error(`SDK outbound-call endpoint returned HTTP ${response.status}`);
  }
  const callSid = typeof payload.callSid === "string" ? payload.callSid : "";
  const callId = typeof payload.callId === "string" ? payload.callId : "";
  const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
  if (!/^CA[0-9a-f]{32}$/iu.test(callSid) || !callId || !sessionId) {
    throw new Error("SDK outbound-call endpoint returned incomplete call identity");
  }
  return { callSid, callId, sessionId };
}

async function waitForCall(
  callsUrl: string,
  callSid: string,
  authorization: string,
  maxWaitMs: number,
  pollMs: number,
): Promise<string> {
  const deadline = Date.now() + maxWaitMs;
  let previousStatus = "";
  while (Date.now() < deadline) {
    const call = await twilioRequest(`${callsUrl}/${callSid}.json`, authorization);
    const status = typeof call.status === "string" ? call.status : "unknown";
    if (status !== previousStatus) {
      console.log(`[twilio-live] call status: ${status}`);
      previousStatus = status;
    }
    if (TERMINAL_CALL_STATUSES.has(status)) return status;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`Call ${callSid} did not finish within ${maxWaitMs}ms`);
}

async function confirmRealCall(to: string): Promise<void> {
  if (process.env.TVIC_ALLOW_LIVE_TWILIO_CALL !== "1") {
    throw new Error(
      "Live calls are disabled. Set TVIC_ALLOW_LIVE_TWILIO_CALL=1 and pass --place-live-call to opt in.",
    );
  }
  if (!process.argv.includes("--place-live-call")) {
    throw new Error("No call was placed. Re-run with --place-live-call when you are ready.");
  }
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error("The live-call confirmation requires an interactive terminal.");
  }
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await readline.question(
      `This will place a real, potentially billable call to ${to}. Type PLACE ${to} to continue: `,
    );
    if (answer.trim() !== `PLACE ${to}`) throw new Error("Live call confirmation did not match");
  } finally {
    readline.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log(
      "Live Twilio outbound call: set TVIC_ALLOW_LIVE_TWILIO_CALL=1 and pass --place-live-call. It places a real call.",
    );
    return;
  }
  loadLocalEnv();
  const config = validateConfig();
  const authorization = authHeader(config.apiUsername, config.apiPassword);
  const publicHost = required("PUBLIC_HOST");

  // No outbound network request occurs until the explicit environment, CLI,
  // and interactive confirmations have all succeeded.
  await confirmRealCall(config.to);
  await checkGateway(publicHost);
  const created = await startCallThroughSdk(
    config.outboundCallUrl,
    config.outboundCallToken,
    config.to,
  );

  console.log(
    `[twilio-live] SDK created call ${created.callSid} (${created.callId}, session ${created.sessionId}); answer ${config.to} and speak to the agent`,
  );
  console.log(
    "[twilio-live] verify gateway logs show TwiML accepted, stream authenticated, and agent connected",
  );
  const status = await waitForCall(
    config.callsUrl,
    created.callSid,
    authorization,
    config.maxWaitMs,
    config.pollMs,
  );
  if (status !== "completed") {
    throw new Error(`Twilio call ended with status ${status}`);
  }
  console.log(
    `[twilio-live] call ${created.callSid} completed; review gateway logs for the audio/session outcome`,
  );
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[twilio-live] ${message}`);
  process.exitCode = 1;
});
