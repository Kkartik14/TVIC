import type { NormalizedError } from "@tvic/core";

// R2-06 Case 12 / R2-08 payload budgets (LOCKED): oversized error causes
// and tool inputs are truncated (JSON-safe, counted), never grown unbounded
// and never silently passed through at full size.
export const MAX_ERROR_CAUSE_BYTES = 4_096;
export const MAX_TOOL_INPUT_BYTES = 65_536;
export const MAX_TOOL_OUTPUT_BYTES = 8_192;
// Durable error readers cap nested strings at 256 characters. Keep the
// diagnostic preview within that same bound so an emitted error can also be
// persisted and recovered without being rejected by the codec.
const MAX_ERROR_CAUSE_PREVIEW_BYTES = 256;

const TRUNCATED_INPUT = Object.freeze({
  $tvic: "input_truncated",
  reason: "exceeds_byte_budget",
});
const TRUNCATED_OUTPUT = Object.freeze({
  $tvic: "output_truncated",
  reason: "exceeds_byte_budget",
});

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function truncateErrorCause(error: NormalizedError): NormalizedError {
  if (error.cause === undefined) return error;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(error.cause);
  } catch {
    return { ...error, cause: { $tvic: "cause_unserializable" } };
  }
  if (serialized === undefined) {
    return { ...error, cause: { $tvic: "cause_unserializable" } };
  }
  if (utf8Length(serialized) <= MAX_ERROR_CAUSE_BYTES) return error;
  // Byte-safe preview: shrink to the last valid UTF-8 boundary so a cut
  // multi-byte sequence never becomes a U+FFFD substitution.
  const previewBytes = new TextEncoder().encode(serialized).slice(0, MAX_ERROR_CAUSE_PREVIEW_BYTES);
  const preview = decodeUtf8Boundary(previewBytes);
  return {
    ...error,
    cause: {
      $tvic: "cause_truncated",
      bytes: utf8Length(serialized),
      preview,
    },
  };
}

function decodeUtf8Boundary(bytes: Uint8Array): string {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let length = bytes.length; length > 0; length -= 1) {
    try {
      return decoder.decode(bytes.slice(0, length));
    } catch {
      // Trailing partial sequence: shrink one byte (at most 3 retries for
      // the longest UTF-8 sequence) and retry.
    }
  }
  return "";
}

export function truncateToolInput(input: unknown): unknown {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(input);
  } catch {
    // Unserializable input can never cross the event boundary as JSON —
    // mark it instead of passing the raw (possibly circular) value through.
    return { $tvic: "input_truncated", reason: "not_serializable" };
  }
  if (serialized === undefined) {
    return { $tvic: "input_truncated", reason: "not_serializable" };
  }
  if (utf8Length(serialized) <= MAX_TOOL_INPUT_BYTES) return input;
  return { ...TRUNCATED_INPUT, bytes: utf8Length(serialized) };
}

export function truncateToolOutput(output: unknown): unknown {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(output);
  } catch {
    return { $tvic: "output_truncated", reason: "not_serializable" };
  }
  if (serialized === undefined) {
    return { $tvic: "output_truncated", reason: "not_serializable" };
  }
  const bytes = utf8Length(serialized);
  if (bytes <= MAX_TOOL_OUTPUT_BYTES) return output;
  return { ...TRUNCATED_OUTPUT, bytes };
}

export function metadataString(
  metadata: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function attachmentAbortReason(signal: AbortSignal | undefined): string | null {
  if (!signal?.aborted) return null;
  const reason = signal.reason;
  if (reason && typeof reason === "object" && "code" in reason) {
    if ((reason as { readonly code?: unknown }).code === "LEASE_LOST") return "lease_lost";
  }
  return "transport_lost";
}
