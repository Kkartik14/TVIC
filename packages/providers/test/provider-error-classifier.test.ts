import { describe, expect, it } from "vitest";

import { TVIC_ERROR_CODES } from "@tvic/core";

import {
  classifiedProviderError,
  classifyProviderError,
  MAX_PROVIDER_ERROR_BODY_BYTES,
  readBoundedProviderErrorBody,
} from "../src/provider-error-classifier.js";

describe("shared provider error classifier", () => {
  it.each([
    [
      "exhausted quota code",
      { providerCode: "insufficient_quota" },
      TVIC_ERROR_CODES.providerQuotaExceeded,
      false,
    ],
    [
      "exhausted billing message",
      { message: "  credits   exhausted " },
      TVIC_ERROR_CODES.providerQuotaExceeded,
      false,
    ],
    [
      "transient 429",
      { status: 429, providerCode: "unknown_vendor_code" },
      TVIC_ERROR_CODES.providerRateLimited,
      true,
    ],
    [
      "invalid request overrides 429",
      { status: 429, providerCode: "invalid_model" },
      TVIC_ERROR_CODES.providerInvalidRequest,
      false,
    ],
    ["auth status", { status: 401 }, TVIC_ERROR_CODES.providerAuthFailed, false],
    [
      "capacity status",
      { status: 498, providerCode: "capacity_exceeded" },
      TVIC_ERROR_CODES.providerUpstreamFailed,
      true,
    ],
    [
      "unknown 498",
      { status: 498, providerCode: "vendor_capacity_shape" },
      TVIC_ERROR_CODES.providerProtocolInvalid,
      false,
    ],
    [
      "exact conflict code",
      { status: 409, providerCode: "conflict" },
      TVIC_ERROR_CODES.providerUpstreamFailed,
      true,
    ],
    [
      "unknown conflict status",
      { status: 409, providerCode: "vendor_conflict_shape" },
      TVIC_ERROR_CODES.providerProtocolInvalid,
      false,
    ],
    [
      "402 is quota unless exact auth code",
      { status: 402, providerCode: "invalid_api_key" },
      TVIC_ERROR_CODES.providerAuthFailed,
      false,
    ],
    [
      "402 unknown is quota",
      { status: 402, providerCode: "billing_state" },
      TVIC_ERROR_CODES.providerQuotaExceeded,
      false,
    ],
    [
      "unknown non-429",
      { status: 499, providerCode: "vendor_free_form" },
      TVIC_ERROR_CODES.providerProtocolInvalid,
      false,
    ],
  ] as const)("classifies %s without substring guessing", (_name, input, code, retriable) => {
    expect(classifyProviderError(input)).toMatchObject({ code, retriable });
  });

  it("does not expose provider message content", () => {
    const error = classifiedProviderError("groq-chat-completions", "Groq request failed", {
      status: 401,
      providerCode: "invalid_api_key",
      message: "secret authorization detail",
    });
    expect(error).toMatchObject({ code: TVIC_ERROR_CODES.providerAuthFailed, retriable: false });
    expect(JSON.stringify(error)).not.toContain("secret authorization detail");
    expect(error.metadata).toMatchObject({ providerCode: "invalid_api_key", httpStatus: 401 });
  });

  it("bounds UTF-8 provider fields before using them as selectors", () => {
    const oversizedCode = "é".repeat(128);
    expect(classifyProviderError({ providerCode: oversizedCode })).toMatchObject({
      code: TVIC_ERROR_CODES.providerProtocolInvalid,
      retriable: false,
      metadata: { boundedFieldRejected: true },
    });
  });

  it("caps response body reads before classification", async () => {
    const response = new Response("x".repeat(MAX_PROVIDER_ERROR_BODY_BYTES + 100));
    const body = await readBoundedProviderErrorBody(response);
    expect(body.truncated).toBe(true);
    expect(Buffer.byteLength(body.text)).toBe(MAX_PROVIDER_ERROR_BODY_BYTES);
  });
});
