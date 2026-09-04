import vm from "node:vm";

import { describe, expect, it } from "vitest";

import {
  TVIC_ERROR_MARKER,
  TVIC_ERROR_NAMES,
  TvicThrowableError,
  authError,
  cancelledError,
  connectionError,
  interruptedError,
  internalError,
  isNormalizedError,
  isTvicError,
  isTvicErrorName,
  mediaError,
  normalizedError,
  normalizeUnknownError,
  providerError,
  rateLimitError,
  signatureError,
  timeoutError,
  toolError,
  tvicErrorFromJSON,
  unknownErrorMessage,
  validationError,
} from "../src/index.js";

describe("isNormalizedError", () => {
  it("accepts a factory-produced error", () => {
    const e = validationError("test.code", "test message");
    expect(isNormalizedError(e)).toBe(true);
  });

  it("rejects null and undefined", () => {
    expect(isNormalizedError(null)).toBe(false);
    expect(isNormalizedError(undefined)).toBe(false);
  });

  it("rejects primitives", () => {
    expect(isNormalizedError(42)).toBe(false);
    expect(isNormalizedError("string")).toBe(false);
    expect(isNormalizedError(true)).toBe(false);
  });

  it("rejects objects with empty message", () => {
    expect(
      isNormalizedError({
        name: "ValidationError",
        code: "x",
        category: "validation",
        message: "",
        retriable: false,
      }),
    ).toBe(false);
  });

  it("rejects objects with unknown name", () => {
    expect(
      isNormalizedError({
        name: "RandomName",
        code: "x",
        category: "validation",
        message: "msg",
        retriable: false,
      }),
    ).toBe(false);
  });

  it("rejects objects with unknown category", () => {
    expect(
      isNormalizedError({
        name: "ValidationError",
        code: "x",
        category: "unicorn",
        message: "msg",
        retriable: false,
      }),
    ).toBe(false);
  });

  it("rejects incoherent name and category pairs", () => {
    expect(
      isNormalizedError({
        name: "ProviderError",
        code: "x",
        category: "media",
        message: "contradictory",
        retriable: true,
      }),
    ).toBe(false);
  });

  it("rejects array metadata", () => {
    expect(
      isNormalizedError({
        name: "ValidationError",
        code: "x",
        category: "validation",
        message: "msg",
        retriable: false,
        metadata: [],
      }),
    ).toBe(false);
  });

  it("returns false for revoked proxies instead of throwing", () => {
    const revoked = Proxy.revocable(validationError("x", "y"), {});
    revoked.revoke();
    expect(isNormalizedError(revoked.proxy)).toBe(false);
  });
});

describe("name survives JSON round-trip", () => {
  it("JSON.stringify preserves the name field", () => {
    const err = validationError("x", "y");
    const round = JSON.parse(JSON.stringify(err));
    expect(round.name).toBe("ValidationError");
  });
  it("TVIC_ERROR_NAMES is frozen", () => {
    expect(Object.isFrozen(TVIC_ERROR_NAMES)).toBe(true);
  });
});

describe("factory name assignment", () => {
  it("validationError sets name to ValidationError", () => {
    expect(validationError("x", "y").name).toBe("ValidationError");
  });
  it("providerError sets name to ProviderError", () => {
    expect(providerError("x", "y").name).toBe("ProviderError");
  });
  it("keeps providerError category aligned at the runtime boundary", () => {
    const error = providerError("x", "y", { category: "media" } as never);
    expect(error).toMatchObject({ name: "ProviderError", category: "provider" });
  });
  it("mediaError sets name to MediaError", () => {
    expect(mediaError("x").name).toBe("MediaError");
  });
  it("timeoutError sets name to TimeoutError", () => {
    expect(timeoutError("x", "y").name).toBe("TimeoutError");
  });
  it("internalError sets name to InternalError", () => {
    expect(internalError("x", "y").name).toBe("InternalError");
  });
  it("authError sets name to AuthError", () => {
    expect(authError("x", "y").name).toBe("AuthError");
  });
  it("rateLimitError sets name to RateLimitError", () => {
    expect(rateLimitError("x", "y").name).toBe("RateLimitError");
  });
  it("connectionError sets name to ConnectionError", () => {
    expect(connectionError("x", "y").name).toBe("ConnectionError");
  });
  it("signatureError sets name to SignatureError", () => {
    expect(signatureError("x", "y").name).toBe("SignatureError");
  });
  it("cancelledError sets name to CancelledError", () => {
    expect(cancelledError("x", "y").name).toBe("CancelledError");
  });
  it("interruptedError sets name to InterruptedError", () => {
    expect(interruptedError("x", "y").name).toBe("InterruptedError");
  });
  it("toolError sets name to ToolError", () => {
    expect(toolError("x", "y").name).toBe("ToolError");
  });
  it("normalizedError defaults to InternalError", () => {
    expect(normalizedError("x", "y").name).toBe("InternalError");
  });
  it("rejects invalid factory values instead of returning an invalid payload", () => {
    expect(() => normalizedError("", "message")).toThrow(
      "Normalized error code must be a non-empty string",
    );
    expect(() => normalizedError("code", "")).toThrow(
      "Normalized error message must be a non-empty string",
    );
  });
  it.each([
    ["validation", "ValidationError"],
    ["auth", "AuthError"],
    ["provider", "ProviderError"],
    ["network", "ConnectionError"],
    ["timeout", "TimeoutError"],
    ["rate_limit", "RateLimitError"],
    ["cancelled", "CancelledError"],
    ["interrupted", "InterruptedError"],
    ["tool", "ToolError"],
    ["media", "MediaError"],
    ["internal", "InternalError"],
  ] as const)("maps %s category to its canonical name", (category, name) => {
    expect(normalizedError("x", "y", { category }).name).toBe(name);
  });
});

describe("factory retriability defaults", () => {
  it("validationError is never retriable", () => {
    expect(validationError("x", "y").retriable).toBe(false);
  });
  it("internalError is never retriable", () => {
    expect(internalError("x", "y").retriable).toBe(false);
  });
  it("providerError is retriable by default", () => {
    expect(providerError("x", "y").retriable).toBe(true);
  });
  it("timeoutError is retriable by default", () => {
    expect(timeoutError("x", "y").retriable).toBe(true);
  });
  it("rateLimitError is retriable by default", () => {
    expect(rateLimitError("x", "y").retriable).toBe(true);
  });
  it("authError is never retriable", () => {
    expect(authError("x", "y").retriable).toBe(false);
  });
  it("signatureError is never retriable", () => {
    expect(signatureError("x", "y").retriable).toBe(false);
  });
  it("cancelledError is never retriable", () => {
    expect(cancelledError("x", "y").retriable).toBe(false);
  });
  it("toolError retriable is overridable", () => {
    expect(toolError("x", "y", { retriable: false }).retriable).toBe(false);
  });
});

describe("isTvicErrorName", () => {
  it("accepts known names", () => {
    for (const name of Object.values(TVIC_ERROR_NAMES)) {
      expect(isTvicErrorName(name)).toBe(true);
    }
  });
  it("rejects unknown names", () => {
    expect(isTvicErrorName("RandomName")).toBe(false);
    expect(isTvicErrorName("")).toBe(false);
    expect(isTvicErrorName(42)).toBe(false);
    expect(isTvicErrorName(null)).toBe(false);
  });
});

describe("TvicThrowableError", () => {
  it("wraps a NormalizedError", () => {
    const inner = validationError("config.missing", "STT key required");
    const thrown = new TvicThrowableError(inner);
    expect(thrown.error).toBe(inner);
    expect(thrown.name).toBe("ValidationError");
    expect(thrown.message).toBe("STT key required");
    expect(thrown instanceof Error).toBe(true);
  });

  it("rejects malformed payloads at the throwable constructor boundary", () => {
    expect(() => new TvicThrowableError({} as never)).toThrow(
      "TvicThrowableError requires a valid NormalizedError",
    );
  });

  it("carries the TVIC_ERROR_MARKER", () => {
    const thrown = TvicThrowableError.from(validationError("x", "y"));
    expect(thrown[TVIC_ERROR_MARKER]).toBe(true);
  });

  it("toJSON returns the underlying NormalizedError", () => {
    const inner = providerError("stt.failed", "boom", { provider: "deepgram" });
    const thrown = new TvicThrowableError(inner);
    expect(thrown.toJSON()).toEqual(inner);
  });

  it("toJSON drops the symbol marker (use tvicErrorFromJSON on the other side)", () => {
    const thrown = TvicThrowableError.from(validationError("x", "y"));
    const serialized = JSON.parse(JSON.stringify(thrown));
    expect(serialized[TVIC_ERROR_MARKER]).toBeUndefined();
  });

  describe("subclassing", () => {
    it("preserves the subclass prototype", () => {
      class CustomTvicError extends TvicThrowableError {}
      const inner = validationError("x", "y");
      const custom = new CustomTvicError(inner);
      expect(custom instanceof CustomTvicError).toBe(true);
      expect(custom instanceof TvicThrowableError).toBe(true);
      expect(custom.error).toBe(inner);
    });
  });

  describe("from()", () => {
    it("returns existing TvicThrowableError unchanged", () => {
      const original = TvicThrowableError.from(validationError("x", "y"));
      const again = TvicThrowableError.from(original);
      expect(again).toBe(original);
    });

    it("wraps a NormalizedError", () => {
      const inner = authError("auth.invalid", "bad key");
      const thrown = TvicThrowableError.from(inner);
      expect(thrown.error).toBe(inner);
      expect(thrown.name).toBe("AuthError");
    });

    it("wraps a generic Error with the Error.name as the code", () => {
      const original = new TypeError("bad input");
      const thrown = TvicThrowableError.from(original);
      expect(thrown.name).toBe("InternalError");
      expect(thrown.message).toBe("bad input");
      expect(thrown.error.code).toBe("error.TypeError");
    });

    it("preserves the original cause when wrapping a generic Error", () => {
      const inner = new Error("root");
      const outer = new Error("wrapper", { cause: inner });
      const thrown = TvicThrowableError.from(outer);
      expect(thrown.error.cause).toBe(inner);
    });

    it("wraps a string with UnknownError", () => {
      const thrown = TvicThrowableError.from("oops");
      expect(thrown.message).toBe("oops");
      expect(thrown.name).toBe("InternalError");
      expect(thrown.error.code).toBe("unknown.error");
    });

    it("wraps a number with UnknownError", () => {
      const thrown = TvicThrowableError.from(42);
      expect(thrown.message).toBe("42");
    });

    it("wraps undefined with UnknownError", () => {
      const thrown = TvicThrowableError.from(undefined);
      expect(thrown.message).toBe("undefined");
    });

    it("wraps null with UnknownError", () => {
      const thrown = TvicThrowableError.from(null);
      expect(thrown.message).toBe("null");
    });

    it("uses a non-empty fallback for an empty string", () => {
      const thrown = TvicThrowableError.from("");
      expect(thrown.message).toBe("Unknown error");
      expect(isNormalizedError(thrown)).toBe(true);
    });

    it("wraps an object", () => {
      const thrown = TvicThrowableError.from({ foo: "bar" });
      expect(thrown.message).toBe("[object Object]");
    });

    it("preserves the identity of an Error from another realm", () => {
      const original = vm.runInNewContext('new TypeError("boom")') as Error;
      const thrown = TvicThrowableError.from(original);
      expect(thrown.error.code).toBe("error.TypeError");
      expect(thrown.message).toBe("boom");
      expect(thrown.error.cause).toBe(original);
    });

    it("upgrades a legacy unnamed normalized error without reclassifying it", () => {
      const legacy = {
        code: "stt.legacy.failure",
        category: "provider",
        message: "legacy provider failure",
        retriable: true,
      };
      const thrown = TvicThrowableError.from(legacy);
      expect(thrown.error).toMatchObject({
        name: "ProviderError",
        code: legacy.code,
        category: legacy.category,
      });
    });

    it("rehydrates a marked cross-realm wrapper carrying a normalized payload", () => {
      const inner = providerError("provider.cross_realm", "transport failed");
      const marked = { [TVIC_ERROR_MARKER]: true, error: inner };
      const thrown = TvicThrowableError.from(marked);
      expect(thrown.error).toBe(inner);
    });

    it("migrates a marked wrapper carrying a legacy payload", () => {
      const marked = {
        [TVIC_ERROR_MARKER]: true,
        error: {
          code: "provider.legacy",
          category: "provider",
          message: "legacy failure",
          retriable: true,
        },
      };
      const thrown = TvicThrowableError.from(marked);
      expect(thrown.error).toMatchObject({
        name: "ProviderError",
        code: "provider.legacy",
        category: "provider",
      });
    });
  });

  it("summarizes native causes when JSON serializing a throwable", () => {
    const thrown = TvicThrowableError.from(new Error("root cause"));
    expect(JSON.stringify(thrown)).toContain('"cause":{"name":"Error","message":"root cause"}');
  });
});

describe("isTvicError", () => {
  it("accepts a TvicThrowableError", () => {
    const thrown = TvicThrowableError.from(validationError("x", "y"));
    expect(isTvicError(thrown)).toBe(true);
  });

  it("rejects a plain NormalizedError (the marker lives only on the throwable)", () => {
    const err = validationError("x", "y");
    expect(isTvicError(err)).toBe(false);
  });

  it("rejects a plain Error", () => {
    expect(isTvicError(new Error("plain"))).toBe(false);
  });

  it("rejects an object with the marker but no NormalizedError shape", () => {
    const fake = { [TVIC_ERROR_MARKER]: true };
    expect(isTvicError(fake)).toBe(false);
  });

  it("rejects primitives", () => {
    expect(isTvicError(null)).toBe(false);
    expect(isTvicError(undefined)).toBe(false);
    expect(isTvicError(42)).toBe(false);
    expect(isTvicError("string")).toBe(false);
  });
});

describe("tvicErrorFromJSON", () => {
  it("re-hydrates a parsed error with a known name", () => {
    const original = authError("auth.invalid", "bad key", { provider: "twilio" });
    const serialized = JSON.parse(JSON.stringify(original));
    const rehydrated = tvicErrorFromJSON(serialized);
    expect(rehydrated).toEqual(original);
  });

  it("re-hydrates a parsed TvicThrowableError (toJSON drops the marker)", () => {
    const thrown = TvicThrowableError.from(rateLimitError("rate.exceeded", "slow down"));
    const serialized = JSON.parse(JSON.stringify(thrown));
    const rehydrated = tvicErrorFromJSON(serialized);
    expect(rehydrated).toEqual(thrown.error);
  });

  it("returns null for objects with unknown name", () => {
    expect(tvicErrorFromJSON({ name: "RandomName" })).toBeNull();
  });

  it("returns null for incoherent name and category pairs", () => {
    expect(
      tvicErrorFromJSON({
        name: "ProviderError",
        code: "x",
        category: "media",
        message: "contradictory",
        retriable: true,
      }),
    ).toBeNull();
  });

  it("returns null instead of defaulting malformed known-name fields", () => {
    expect(tvicErrorFromJSON({ name: "AuthError", code: "x", message: "y" })).toBeNull();
    expect(
      tvicErrorFromJSON({
        name: "AuthError",
        code: "x",
        category: "auth",
        message: "y",
        retriable: "false",
      }),
    ).toBeNull();
  });

  it("returns null for primitives", () => {
    expect(tvicErrorFromJSON(null)).toBeNull();
    expect(tvicErrorFromJSON(undefined)).toBeNull();
    expect(tvicErrorFromJSON("string")).toBeNull();
    expect(tvicErrorFromJSON(42)).toBeNull();
  });

  it("returns null for already-valid NormalizedError without recognized name", () => {
    // Defensive: if a future code path produces an unbranded error, do not
    // pretend it is a TVIC error.
    expect(
      tvicErrorFromJSON({ code: "x", category: "internal", message: "y", retriable: false }),
    ).toBeNull();
  });

  it("round-trip preserves provider, retriable, and metadata", () => {
    const original = connectionError("net.timeout", "no route", {
      provider: "cartesia",
      metadata: { retryAfterMs: 1000 },
    });
    const serialized = JSON.parse(JSON.stringify(original));
    const rehydrated = tvicErrorFromJSON(serialized);
    expect(rehydrated).toEqual(original);
  });
});

describe("normalizeUnknownError", () => {
  it("returns existing NormalizedError unchanged", () => {
    const original = validationError("x", "y");
    expect(normalizeUnknownError(original, { code: "ignored" })).toBe(original);
  });

  it("normalizes a string with the provided code", () => {
    const result = normalizeUnknownError("boom", { code: "config.bad" });
    expect(result.code).toBe("config.bad");
    expect(result.message).toBe("boom");
  });

  it("preserves the original as cause", () => {
    const original = new Error("root");
    const result = normalizeUnknownError(original, { code: "x" });
    expect(result.cause).toBe(original);
  });

  it("preserves retriable override", () => {
    const result = normalizeUnknownError("x", { code: "y", retriable: false });
    expect(result.retriable).toBe(false);
  });

  it("upgrades a legacy unnamed normalized error", () => {
    const result = normalizeUnknownError(
      {
        code: "legacy.timeout",
        category: "timeout",
        message: "old timeout",
        retriable: true,
      },
      { code: "ignored", category: "provider", retriable: false },
    );
    expect(result).toMatchObject({
      name: "TimeoutError",
      code: "legacy.timeout",
      category: "timeout",
      retriable: true,
    });
  });

  it("uses a non-empty message for an Error with no message", () => {
    const result = normalizeUnknownError(new Error(""), { code: "empty.message" });
    expect(result.message).toBe("Unknown error");
    expect(isNormalizedError(result)).toBe(true);
  });
});

describe("unknownErrorMessage", () => {
  it("returns Error.message", () => {
    expect(unknownErrorMessage(new Error("hello"))).toBe("hello");
  });
  it("returns String() for non-Error", () => {
    expect(unknownErrorMessage("x")).toBe("x");
    expect(unknownErrorMessage(42)).toBe("42");
    expect(unknownErrorMessage(null)).toBe("null");
    expect(unknownErrorMessage(undefined)).toBe("undefined");
  });
  it("does not throw on Symbol (calls .toString() explicitly)", () => {
    expect(unknownErrorMessage(Symbol("rate_limited"))).toBe("Symbol(rate_limited)");
  });
  it("falls back safely for objects without primitive conversion", () => {
    expect(unknownErrorMessage(Object.create(null))).toBe("Unknown error");
  });
});
