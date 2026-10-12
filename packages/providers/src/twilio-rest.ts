import { PROVIDER_NAMES, TvicThrowableError } from "@tvic/core";
import type { NormalizedError } from "@tvic/core";

import { providerError } from "./common.js";

export interface TwilioRestOptions {
  readonly accountSid: string;
  readonly authToken?: string;
  readonly apiKeySid?: string;
  readonly apiKeySecret?: string;
}

export interface TwilioCallResource {
  readonly sid: string;
  readonly status: string;
}

export type TwilioCallStatus =
  | "queued"
  | "initiated"
  | "ringing"
  | "in-progress"
  | "completed"
  | "busy"
  | "failed"
  | "no-answer"
  | "canceled";

const CALL_SID_PATTERN = /^CA[0-9a-f]{32}$/iu;
const ACCOUNT_SID_PATTERN = /^AC[0-9a-f]{32}$/iu;
const API_KEY_SID_PATTERN = /^SK[0-9a-f]{32}$/iu;

export function validateTwilioRestOptions(options: TwilioRestOptions): void {
  if (!ACCOUNT_SID_PATTERN.test(options.accountSid)) {
    throw new TypeError("Twilio accountSid must be an Account SID beginning with AC");
  }
  if ((options.apiKeySid === undefined) !== (options.apiKeySecret === undefined)) {
    throw new TypeError("Twilio apiKeySid and apiKeySecret must be provided together");
  }
  if (options.apiKeySid !== undefined && !API_KEY_SID_PATTERN.test(options.apiKeySid)) {
    throw new TypeError("Twilio apiKeySid must be an API key SID beginning with SK");
  }
  if (!options.apiKeySid && !options.authToken) {
    throw new TypeError("Twilio REST calls require an API key pair or an auth token");
  }
}

export function twilioCallsUrl(accountSid: string): string {
  return `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls`;
}

export function twilioAuthorization(options: TwilioRestOptions): string {
  const username = options.apiKeySid ?? options.accountSid;
  const password = options.apiKeySecret ?? options.authToken;
  if (!password) throw new TypeError("Twilio REST authentication is not configured");
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

export async function createTwilioCall(
  options: TwilioRestOptions,
  body: URLSearchParams,
): Promise<TwilioCallResource> {
  return await twilioRequest(
    `${twilioCallsUrl(options.accountSid)}.json`,
    options,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    },
    { callCreation: true },
  );
}

export async function updateTwilioCall(
  options: TwilioRestOptions,
  callSid: string,
  status: "completed" | "canceled",
): Promise<void> {
  if (!CALL_SID_PATTERN.test(callSid)) {
    throw new TypeError("Twilio callSid must be a Call SID beginning with CA");
  }
  await twilioRequest(`${twilioCallsUrl(options.accountSid)}/${callSid}.json`, options, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ Status: status }),
  });
}

export function normalizeTwilioCallStatus(value: unknown): TwilioCallStatus | null {
  switch (value) {
    case "queued":
    case "initiated":
    case "ringing":
    case "in-progress":
    case "completed":
    case "busy":
    case "failed":
    case "no-answer":
    case "canceled":
      return value;
    default:
      return null;
  }
}

async function twilioRequest(
  url: string,
  options: TwilioRestOptions,
  init: RequestInit,
  safety: { readonly callCreation?: boolean } = {},
): Promise<TwilioCallResource> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init.headers).entries()),
        authorization: twilioAuthorization(options),
        accept: "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const outcomeUnknown = safety.callCreation === true;
    throw twilioRestError(
      outcomeUnknown
        ? "Twilio Calls API response was lost; call creation outcome is unknown"
        : "Twilio Calls API request failed",
      error,
      !outcomeUnknown,
      undefined,
      outcomeUnknown,
    );
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!isRecord(payload)) {
    const outcomeUnknown = safety.callCreation === true && (response.ok || response.status >= 500);
    throw twilioRestError(
      `Twilio Calls API returned HTTP ${response.status}${outcomeUnknown ? "; call creation outcome is unknown" : ""}`,
      undefined,
      false,
      undefined,
      outcomeUnknown,
    );
  }
  if (!response.ok) {
    const message = typeof payload.message === "string" ? payload.message : "request failed";
    const code = typeof payload.code === "number" ? payload.code : undefined;
    throw twilioRestError(
      `Twilio Calls API HTTP ${response.status}${code === undefined ? "" : ` (${code})`}: ${message}${safety.callCreation && response.status >= 500 ? "; call creation outcome is unknown" : ""}`,
      undefined,
      response.status === 429 || (response.status >= 500 && !safety.callCreation),
      code,
      safety.callCreation === true && response.status >= 500,
    );
  }

  if (typeof payload.sid !== "string" || !CALL_SID_PATTERN.test(payload.sid)) {
    throw twilioRestError(
      "Twilio Calls API returned an invalid Call SID",
      undefined,
      false,
      undefined,
      safety.callCreation === true,
    );
  }
  return {
    sid: payload.sid,
    status: typeof payload.status === "string" ? payload.status : "queued",
  };
}

function twilioRestError(
  message: string,
  cause: unknown,
  retriable: boolean,
  twilioErrorCode?: number,
  outcomeUnknown = false,
): TvicThrowableError {
  const details: Record<string, unknown> = {};
  if (cause !== undefined) details.cause = cause;
  if (twilioErrorCode !== undefined) details.twilioErrorCode = twilioErrorCode;
  if (outcomeUnknown) details.outcomeUnknown = true;
  const error: NormalizedError = providerError("twilio.calls_api_error", message, {
    provider: PROVIDER_NAMES.twilio,
    retriable,
    ...(cause !== undefined ? { cause } : {}),
    ...(Object.keys(details).length > 0 ? { metadata: details } : {}),
  });
  return TvicThrowableError.from(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
