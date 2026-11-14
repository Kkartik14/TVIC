import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PROVIDER_ERROR_CODES,
  PROVIDER_NAMES,
  TVIC_ERROR_CODES,
  type SessionId,
  type TurnId,
  type LlmStreamEvent,
} from "@tvic/core";
import { OpenAiResponsesLlmProvider } from "../src/index.js";

afterEach(() => vi.unstubAllGlobals());

async function failureEvent(): Promise<Extract<LlmStreamEvent, { type: "llm.failed" }>> {
  const provider = new OpenAiResponsesLlmProvider({ apiKey: "test-key" });
  const completion = await provider.complete({
    sessionId: "session_provider_failure" as SessionId,
    turnId: "turn_provider_failure" as TurnId,
    model: "gpt-4.1-mini",
    messages: [{ role: "user", content: "synthetic test input" }],
    stream: true,
  });

  for await (const event of completion.events) {
    if (event.type === "llm.failed") return event;
  }
  throw new Error("OpenAI did not emit a failed event");
}

function sseResponse(event: Readonly<Record<string, unknown>>): Response {
  const data = new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
  return new Response(data, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("OpenAI Responses provider errors", () => {
  it("maps the documented exhausted-credit response to a permanent quota error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: {
              message: "The organization's credit balance is exhausted.",
              type: "insufficient_quota",
              param: null,
              code: "credit_balance_exhausted",
            },
          },
          { status: 429 },
        ),
      ),
    );

    const event = await failureEvent();

    expect(event.error).toMatchObject({
      code: TVIC_ERROR_CODES.providerQuotaExceeded,
      category: "provider",
      provider: PROVIDER_NAMES.openaiResponses,
      retriable: false,
      metadata: {
        httpStatus: 429,
        providerCode: "credit_balance_exhausted",
        providerType: "insufficient_quota",
        classification: "quota_exceeded",
      },
    });
    expect(event.error.message).toBe("OpenAI credit balance or usage limit exhausted");
    expect(event.error.message).not.toContain("credit balance is exhausted");
  });

  it("preserves structured failure causes from response.failed events", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse({
          type: "response.failed",
          response: {
            error: {
              code: "server_error",
              type: "server_error",
              message: "A provider diagnostic that must not be surfaced.",
            },
          },
        }),
      ),
    );

    const event = await failureEvent();

    expect(event.error).toMatchObject({
      code: TVIC_ERROR_CODES.providerUpstreamFailed,
      provider: PROVIDER_NAMES.openaiResponses,
      retriable: true,
      metadata: {
        providerCode: "server_error",
        providerType: "server_error",
        classification: "upstream",
      },
    });
    expect(event.error.message).toBe("OpenAI API is temporarily unavailable");
    expect(event.error.message).not.toContain("provider diagnostic");
  });

  it("keeps the legacy failure code when an event has no structured cause", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse({
          type: "response.failed",
          response: { error: { message: "Provider diagnostic is private." } },
        }),
      ),
    );

    const event = await failureEvent();

    expect(event.error).toMatchObject({
      code: PROVIDER_ERROR_CODES.openaiResponseFailed,
      provider: PROVIDER_NAMES.openaiResponses,
      retriable: true,
    });
    expect(event.error.message).toBe("OpenAI response failed");
    expect(event.error.message).not.toContain("Provider diagnostic");
  });
});
