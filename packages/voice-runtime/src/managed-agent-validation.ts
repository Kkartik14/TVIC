import { TvicThrowableError, validationError } from "@tvic/core";
import type { ChannelKind } from "@tvic/core";
import type { VoiceAgentRunOptions } from "./managed-agent.js";

export function configurationError(message: string): never {
  throw TvicThrowableError.from(validationError("voice_runtime.invalid_config", message));
}

export function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return configurationError(`${field} must be a non-empty string`);
  }
  return value;
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    isRecord(value) &&
    typeof value.aborted === "boolean" &&
    typeof value.addEventListener === "function" &&
    typeof value.removeEventListener === "function"
  );
}

function isChannelKind(value: unknown): value is ChannelKind {
  return value === "phone" || value === "web_audio" || value === "simulated";
}

export function validateRunOptions(options: VoiceAgentRunOptions): void {
  if (options.signal !== undefined && !isAbortSignal(options.signal)) {
    configurationError("signal must be an AbortSignal");
  }
  if (options.channel !== undefined && !isChannelKind(options.channel)) {
    configurationError(`channel must be phone, web_audio, or simulated`);
  }
  for (const [field, value] of [
    ["variables", options.variables],
    ["metadata", options.metadata],
  ] as const) {
    if (value !== undefined && !isRecord(value)) {
      configurationError(`${field} must be an object`);
    }
  }
  for (const [field, value] of [
    ["memoryUserId", options.memoryUserId],
    ["organizationId", options.organizationId],
    ["workflowId", options.workflowId],
    ["safetyIdentifier", options.safetyIdentifier],
    ["sttLanguage", options.sttLanguage],
  ] as const) {
    if (value !== undefined) nonEmpty(value, field);
  }
  if (
    options.textDelivery !== undefined &&
    options.textDelivery !== "auto" &&
    options.textDelivery !== "always" &&
    options.textDelivery !== "never"
  ) {
    configurationError("textDelivery must be auto, always, or never");
  }
  for (const [field, value] of [
    ["streamStallTimeoutMs", options.streamStallTimeoutMs],
    ["turnEndpointTimeoutMs", options.turnEndpointTimeoutMs],
    ["turnMaxDurationMs", options.turnMaxDurationMs],
    ["startupTimeoutMs", options.startupTimeoutMs],
  ] as const) {
    if (
      value !== undefined &&
      field !== "startupTimeoutMs" &&
      (!Number.isFinite(value) || value <= 0)
    ) {
      configurationError(`${field} must be a positive finite number`);
    }
    if (
      value !== undefined &&
      field === "startupTimeoutMs" &&
      (!Number.isSafeInteger(value) || value <= 0)
    ) {
      configurationError("startupTimeoutMs must be a positive safe integer");
    }
  }
}
