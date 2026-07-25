import type { Call } from "../call.js";
import type { CallId, SessionId } from "../ids.js";
import type {
  InputMediaEvent,
  InternalMediaEvent,
  OutputMediaEvent,
  StreamEndReason,
} from "../media.js";
import type { Provider } from "../provider.js";

export interface OutboundCallRequest {
  readonly callId: CallId;
  readonly sessionId: SessionId;
  readonly from: string;
  readonly to: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface InboundCallContext {
  readonly call: Call;
}

export type InboundMediaEvent = InputMediaEvent | InternalMediaEvent;

export interface CallHandle {
  readonly callId: CallId;
  readonly events: AsyncIterable<InboundMediaEvent>;
  /**
   * Sends an outbound frame. Returns `true` if it reached the transport, `false`
   * if the socket was closed/closing and the frame was dropped, so the caller can
   * tell "delivered" from "silently swallowed" instead of assuming success.
   */
  send(event: OutputMediaEvent): Promise<boolean>;
  clear(): Promise<void>;
  close(reason: StreamEndReason): Promise<void>;
  /**
   * Resolves once the transport confirms the marked output was actually played out
   * to the caller (e.g. a Twilio mark ack): `true` if heard, `false` if the call
   * dropped before playout. Optional: providers that can't observe playout omit it,
   * and callers then fall back to "reached transport" as their delivery signal.
   */
  confirmPlayout?(markId: string, timeoutMs: number): Promise<boolean>;
}

export interface TelephonyProvider extends Provider {
  readonly kind: "telephony";
  dial(request: OutboundCallRequest): Promise<CallHandle>;
  accept(ctx: InboundCallContext): Promise<CallHandle>;
  hangup(callId: CallId): Promise<void>;
}
