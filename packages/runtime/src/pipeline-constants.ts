export const CLEAR_TIMEOUT_MS = 250;
export const STARTUP_TIMEOUT_MS = 15_000;
export const STT_CLOSE_TIMEOUT_MS = 1_000;
export const PROVIDER_CANCEL_TIMEOUT_MS = 1_000;
export const TRANSPORT_SEND_TIMEOUT_MS = 5_000;
export const PLAYOUT_CONFIRM_TIMEOUT_MS = 30_000;
export const STT_SEND_TIMEOUT_MS = 5_000;
export const STT_COMMIT_TIMEOUT_MS = 5_000;
export const TTS_SEND_TIMEOUT_MS = 5_000;
export const TTS_FLUSH_TIMEOUT_MS = 5_000;
export const TTS_FINISH_TIMEOUT_MS = 5_000;
// Bounds a transport that accepts an outbound frame but never resolves the
// delivery promise. The transport remains responsible for its own socket
// cancellation; the runtime must not wait forever for acknowledgement.
export const TEXT_DELIVERY_TIMEOUT_MS = 5_000;
export const DEFAULT_TURN_ENDPOINT_TIMEOUT_MS = 3_000;
export const DEFAULT_TURN_MAX_DURATION_MS = 30_000;
/** Provider-neutral ceilings enforced by the live runtime around custom adapters. */
export const MAX_RUNTIME_LLM_OUTPUT_BYTES = 4 * 1024 * 1024;
export const MAX_RUNTIME_LLM_EVENTS = 16_384;
export const MAX_RUNTIME_LLM_TOOL_CALLS = 128;
export const MAX_RUNTIME_LLM_TOOL_ARGUMENT_BYTES = 1024 * 1024;
export const MAX_RUNTIME_LLM_TOOL_FIELD_BYTES = 4_096;
export const MAX_RUNTIME_INCREMENTAL_TTS_BUFFER_BYTES = 1024 * 1024;
export const MAX_RUNTIME_TTS_ALIGNMENT_TOKENS = 16_384;
export const MAX_RUNTIME_TTS_ALIGNMENT_TOKEN_BYTES = 1024 * 1024;
export const MAX_RUNTIME_TTS_ALIGNMENT_ARRAY_ENTRIES = 16_384;
// Bound post-shutdown transcript draining if a provider never closes its stream.
export const TRANSCRIPT_DRAIN_TIMEOUT_MS = 5_000;
// Bound provider cleanup when cancel/close promises never settle. Timed-out waits
// report degraded cleanup and proceed;
// provider-owned resources remain the provider/host's responsibility.
export const CANCELLATION_TIMEOUT_MS = 5_000;
