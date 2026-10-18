import type { CallHandle } from "@tvic/core";
import { TvicThrowableError, validationError } from "@tvic/core";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function dataProperty(value: object, property: PropertyKey): unknown {
  const seen = new Set<object>();
  let current: object | null = value;
  try {
    while (current !== null && !seen.has(current)) {
      seen.add(current);
      const descriptor = Object.getOwnPropertyDescriptor(current, property);
      if (descriptor) return "value" in descriptor ? descriptor.value : undefined;
      current = Object.getPrototypeOf(current);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return isRecord(value) && typeof dataProperty(value, Symbol.asyncIterator) === "function";
}

export function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return isRecord(value) && typeof dataProperty(value, "then") === "function";
}

export function isCallHandle(value: unknown): value is CallHandle {
  if (!isRecord(value)) {
    return false;
  }
  const callId = dataProperty(value, "callId");
  if (typeof callId !== "string" || callId.trim().length === 0) return false;
  const events = dataProperty(value, "events");
  const remoteHangup = dataProperty(value, "remoteHangup");
  return (
    isAsyncIterable(events) &&
    typeof dataProperty(value, "send") === "function" &&
    typeof dataProperty(value, "clear") === "function" &&
    typeof dataProperty(value, "close") === "function" &&
    (dataProperty(value, "endInput") === undefined ||
      typeof dataProperty(value, "endInput") === "function") &&
    (dataProperty(value, "deliverText") === undefined ||
      typeof dataProperty(value, "deliverText") === "function") &&
    (dataProperty(value, "confirmPlayout") === undefined ||
      typeof dataProperty(value, "confirmPlayout") === "function") &&
    (remoteHangup === undefined || isPromiseLike(remoteHangup))
  );
}

export function validateCallHandle(value: unknown): asserts value is CallHandle {
  if (!isCallHandle(value)) {
    throw TvicThrowableError.from(
      validationError(
        "voice_runtime.invalid_config",
        "callHandle must include a non-empty callId, async events, and send/clear/close methods; optional endInput and remoteHangup must have valid shapes",
      ),
    );
  }
}
