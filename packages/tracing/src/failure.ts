import type { NormalizedError, TraceEventId } from "@tvic/core";

/**
 * Why a turn or call ended badly, or why something went wrong inside a turn that the
 * conversation recovered from. All semantics live here (not React): a `FailureKind`
 * derives from a terminal `turn.ended`/`session.failed` error or cancel reason; an
 * `IncidentKind` derives from a non-terminal problem (a recovered tool failure, a
 * retry, a rejected barge-in).
 */
export type FailureCategory = "runtime" | "provider" | "tool" | "transport" | "policy" | "artifact";

export type FailureSeverity = "error" | "warning" | "info";

export type FailureKind =
  | "provider_stalled"
  | "provider_failed"
  | "tool_failed"
  | "tool_input_validation_failed"
  | "tool_output_validation_failed"
  | "transport_closed"
  | "playout_unconfirmed"
  | "interrupted"
  | "remote_hangup"
  | "stt_closed_unexpectedly"
  | "artifact_degraded"
  | "runtime_error"
  | "unknown";

export interface FailureExplanation {
  readonly kind: FailureKind;
  readonly category: FailureCategory;
  readonly severity: FailureSeverity;
  readonly title: string;
  readonly message: string;
  readonly technicalCode?: string;
  readonly provider?: string;
  readonly toolName?: string;
  readonly retryable?: boolean;
  readonly userFacingEffect: string;
  readonly occurredAtMs: number;
  readonly evidenceEventIds: readonly TraceEventId[];
  readonly debugHints: readonly string[];
}

export type IncidentKind =
  | "tool_retry"
  | "tool_failed_recovered"
  | "tool_failed_unrecovered"
  | "tool_input_validation_failed"
  | "tool_output_validation_failed"
  | "rejected_barge_in"
  | "artifact_warning";

// `provider_retry` is reserved for a future provider-level retry policy; the runtime
// does not emit provider retries today, so the analyzer never produces it.

export interface IncidentView {
  readonly kind: IncidentKind;
  readonly category: FailureCategory;
  readonly severity: FailureSeverity;
  readonly title: string;
  readonly message: string;
  readonly technicalCode?: string;
  readonly provider?: string;
  readonly toolName?: string;
  readonly attempt?: number;
  readonly retryable?: boolean;
  readonly occurredAtMs: number;
  readonly resolvedAtMs?: number;
  readonly evidenceEventIds: readonly TraceEventId[];
}

interface KindDescriptor {
  readonly category: FailureCategory;
  readonly title: string;
  readonly userFacingEffect: string;
  readonly debugHints: readonly string[];
}

const FAILURE_DESCRIPTORS: Readonly<Record<FailureKind, KindDescriptor>> = {
  provider_stalled: {
    category: "provider",
    title: "Provider stalled",
    userFacingEffect: "The caller heard dead air; no reply was delivered for this turn.",
    debugHints: [
      "Check the stalled provider's latency and health.",
      "Tune streamStallTimeoutMs / the agent timeoutPolicy.",
    ],
  },
  provider_failed: {
    category: "provider",
    title: "Provider failed",
    userFacingEffect: "The reply could not be generated for this turn.",
    debugHints: [
      "Inspect the provider error code and message.",
      "Check API keys, quotas, and region.",
    ],
  },
  tool_failed: {
    category: "tool",
    title: "Tool failed",
    userFacingEffect:
      "The agent could not complete the requested action; the model was given a tool-error message.",
    debugHints: ["Inspect the tool error.", "Check the tool's downstream dependency."],
  },
  tool_input_validation_failed: {
    category: "tool",
    title: "Tool input invalid",
    userFacingEffect:
      "The model called the tool with arguments that failed input-schema validation.",
    debugHints: [
      "Compare the tool inputSchema with the arguments the model produced.",
      "Tighten the tool description so the model fills arguments correctly.",
    ],
  },
  tool_output_validation_failed: {
    category: "tool",
    title: "Tool output invalid",
    userFacingEffect:
      "The tool returned data that failed its output schema; the model was given a tool-error message.",
    debugHints: ["Compare the tool outputSchema with the actual returned value."],
  },
  transport_closed: {
    category: "transport",
    title: "Transport closed",
    userFacingEffect: "The media connection dropped; the caller could no longer hear the agent.",
    debugHints: ["Check the telephony/media socket.", "Look for a network drop or remote close."],
  },
  playout_unconfirmed: {
    category: "transport",
    title: "Playout not confirmed",
    userFacingEffect:
      "Audio was sent to the transport, but the caller is not confirmed to have heard it (e.g. a hangup during playout).",
    debugHints: [
      "Check whether the call dropped during playout.",
      "Confirm the transport returns playout mark acknowledgements.",
    ],
  },
  interrupted: {
    category: "policy",
    title: "Caller interrupted",
    userFacingEffect:
      "The caller barged in during the agent's reply; output was cancelled before it finished playing.",
    debugHints: ["Review barge-in thresholds.", "Check the agent interruption policy."],
  },
  remote_hangup: {
    category: "transport",
    title: "Caller hung up",
    userFacingEffect: "The caller ended the call.",
    debugHints: ["Expected when the caller is done; otherwise check call quality."],
  },
  stt_closed_unexpectedly: {
    category: "provider",
    title: "STT closed unexpectedly",
    userFacingEffect:
      "Speech recognition disconnected mid-call; the agent stopped understanding the caller.",
    debugHints: ["Check the STT provider connection and health.", "Inspect STT error logs."],
  },
  artifact_degraded: {
    category: "artifact",
    title: "Degraded artifacts",
    userFacingEffect: "Some trace or audio data was lost; this record may be incomplete.",
    debugHints: [
      "Check the artifact writer's error channel.",
      "Verify disk space and permissions for the calls directory.",
    ],
  },
  runtime_error: {
    category: "runtime",
    title: "Runtime error",
    userFacingEffect: "An unexpected runtime error ended the turn.",
    debugHints: ["Inspect the error message.", "File a bug with the call trace attached."],
  },
  unknown: {
    category: "runtime",
    title: "Unknown failure",
    userFacingEffect: "The turn failed for an unclassified reason.",
    debugHints: ["Inspect the raw error and the evidence events."],
  },
};

/** Classifies a NormalizedError (from a failed turn or session) into a FailureKind. */
export function classifyError(error: NormalizedError): FailureKind {
  const code = error.code;
  if (code === "stt.closed_unexpectedly") {
    return "stt_closed_unexpectedly";
  }
  if (code === "llm.stalled" || code === "tts.stalled" || error.category === "timeout") {
    return "provider_stalled";
  }
  if (code.startsWith("tool.input_validation")) {
    return "tool_input_validation_failed";
  }
  if (code.startsWith("tool.output_validation")) {
    return "tool_output_validation_failed";
  }
  if (code.startsWith("tool.") || error.category === "tool") {
    return "tool_failed";
  }
  if (
    code === "media.input_failed" ||
    code.includes("media_stream") ||
    error.category === "media"
  ) {
    return "transport_closed";
  }
  if (error.category === "provider" || error.category === "network") {
    return "provider_failed";
  }
  return "runtime_error";
}

/** Classifies a turn/session cancel reason string into a FailureKind. */
export function classifyCancelReason(reason: string): FailureKind {
  switch (reason) {
    case "barge_in":
    case "dtmf":
    case "explicit":
      return "interrupted";
    case "not_heard":
      return "playout_unconfirmed";
    case "timeout":
      return "provider_stalled";
    case "remote_hangup":
      return "remote_hangup";
    case "transport_closed":
    case "media_error":
      return "transport_closed";
    case "stt_error":
    case "stt_ended":
      return "stt_closed_unexpectedly";
    default:
      return "unknown";
  }
}

export interface BuildFailureInput {
  readonly kind: FailureKind;
  readonly occurredAtMs: number;
  readonly evidenceEventIds: readonly TraceEventId[];
  readonly error?: NormalizedError;
  readonly toolName?: string;
  readonly messageOverride?: string;
}

/** Builds a full FailureExplanation from a classified kind plus the underlying error. */
export function buildFailure(input: BuildFailureInput): FailureExplanation {
  const descriptor = FAILURE_DESCRIPTORS[input.kind];
  return {
    kind: input.kind,
    category: descriptor.category,
    severity: "error",
    title: descriptor.title,
    message: input.messageOverride ?? input.error?.message ?? descriptor.userFacingEffect,
    ...(input.error?.code ? { technicalCode: input.error.code } : {}),
    ...(input.error?.provider ? { provider: input.error.provider } : {}),
    ...(input.toolName ? { toolName: input.toolName } : {}),
    ...(input.error ? { retryable: input.error.retriable } : {}),
    userFacingEffect: descriptor.userFacingEffect,
    occurredAtMs: input.occurredAtMs,
    evidenceEventIds: input.evidenceEventIds,
    debugHints: descriptor.debugHints,
  };
}

const INCIDENT_DESCRIPTORS: Readonly<
  Record<IncidentKind, { title: string; category: FailureCategory }>
> = {
  tool_retry: { title: "Tool retried", category: "tool" },
  tool_failed_recovered: { title: "Tool failed (recovered)", category: "tool" },
  tool_failed_unrecovered: { title: "Tool failed (turn did not recover)", category: "tool" },
  tool_input_validation_failed: { title: "Tool input invalid", category: "tool" },
  tool_output_validation_failed: { title: "Tool output invalid", category: "tool" },
  rejected_barge_in: { title: "Barge-in rejected", category: "policy" },
  artifact_warning: { title: "Artifact warning", category: "artifact" },
};

export interface BuildIncidentInput {
  readonly kind: IncidentKind;
  readonly occurredAtMs: number;
  readonly evidenceEventIds: readonly TraceEventId[];
  readonly message: string;
  readonly error?: NormalizedError;
  readonly toolName?: string;
  readonly attempt?: number;
  readonly resolvedAtMs?: number;
}

export function buildIncident(input: BuildIncidentInput): IncidentView {
  const descriptor = INCIDENT_DESCRIPTORS[input.kind];
  return {
    kind: input.kind,
    category: descriptor.category,
    severity: "warning",
    title: descriptor.title,
    message: input.message,
    ...(input.error?.code ? { technicalCode: input.error.code } : {}),
    ...(input.error?.provider ? { provider: input.error.provider } : {}),
    ...(input.toolName ? { toolName: input.toolName } : {}),
    ...(typeof input.attempt === "number" ? { attempt: input.attempt } : {}),
    ...(input.error ? { retryable: input.error.retriable } : {}),
    occurredAtMs: input.occurredAtMs,
    ...(typeof input.resolvedAtMs === "number" ? { resolvedAtMs: input.resolvedAtMs } : {}),
    evidenceEventIds: input.evidenceEventIds,
  };
}

/** Maps a recovered tool error code to the matching incident kind. */
export function toolErrorIncidentKind(code: string): IncidentKind {
  if (code.startsWith("tool.input_validation")) {
    return "tool_input_validation_failed";
  }
  if (code.startsWith("tool.output_validation")) {
    return "tool_output_validation_failed";
  }
  return "tool_failed_recovered";
}
