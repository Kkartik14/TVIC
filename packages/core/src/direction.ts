export type MediaDirection = "input" | "output" | "internal";

export type CallDirection = "inbound" | "outbound";

/**
 * Channels TVIC 1.0 can actually execute. `sip` and `whatsapp` are intentionally
 * absent until a working transport exists — the union never claims a capability
 * the runtime cannot run.
 */
export type ChannelKind = "phone" | "web_audio" | "simulated";
