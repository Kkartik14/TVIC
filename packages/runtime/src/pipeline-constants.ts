export const CLEAR_TIMEOUT_MS = 250;
export const STARTUP_TIMEOUT_MS = 15_000;
export const PLAYOUT_CONFIRM_TIMEOUT_MS = 30_000;
export const STT_SEND_TIMEOUT_MS = 5_000;
export const STT_COMMIT_TIMEOUT_MS = 5_000;
export const TTS_SEND_TIMEOUT_MS = 5_000;
export const TTS_FLUSH_TIMEOUT_MS = 5_000;
export const TTS_FINISH_TIMEOUT_MS = 5_000;
// Bounds a transport that accepts an outbound frame but never resolves the
// delivery promise. The transport remains responsible for its own socket
// cancellation; the runtime must not wait forever for acknowledgement.
export const TRANSPORT_SEND_TIMEOUT_MS = 5_000;
export const TEXT_DELIVERY_TIMEOUT_MS = 5_000;
export const DEFAULT_TURN_ENDPOINT_TIMEOUT_MS = 3_000;
export const DEFAULT_TURN_MAX_DURATION_MS = 30_000;
// R2-05: bound the post-shutdown transcript drain so a provider that never
// closes its event stream cannot hold the session forever.
export const TRANSCRIPT_DRAIN_TIMEOUT_MS = 5_000;
// R2-05/P-11: bound for non-cooperative provider cleanup (cancel/close
// promises that never settle). Exceeded waits report degraded and proceed;
// provider-owned resources remain the provider/host's responsibility.
export const CANCELLATION_TIMEOUT_MS = 5_000;
