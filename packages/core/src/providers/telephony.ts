import type { Call } from "../call.js";
import type { CallId, SessionId, TurnId } from "../ids.js";
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
   * Resolves when the remote caller ends the call or the peer transport drops,
   * including after `endInput()`; host-initiated close does not resolve it.
   * Optional for transports that cannot distinguish remote from host closure.
   */
  readonly remoteHangup?: Promise<void>;
  /**
   * Sends an outbound frame. Returns `true` if it reached the transport, `false`
   * if the socket was closed/closing and the frame was dropped, so the caller can
   * tell "delivered" from "silently swallowed" instead of assuming success.
   */
  send(event: OutputMediaEvent): Promise<boolean>;
  /** Delivers whole-turn assistant text to transports with a text channel. */
  deliverText?(turnId: TurnId, sequence: number, text: string): Promise<boolean>;
  clear(): Promise<void>;
  /**
   * Ends inbound media while keeping outbound delivery available. The stream
   * end reason describes the input stream. A remote media client should be
   * notified so it can stop capture while outbound delivery continues;
   * `close(reason)` later reports the final call outcome after runtime
   * arbitration. Optional for transports that cannot half-close input;
   * `ManagedVoiceAgentSession.complete()` reports an unsupported-operation
   * error when this method is absent.
   */
  endInput?(reason: StreamEndReason): Promise<void>;
  /**
   * Ends this call with the given terminal reason. Providers flush accepted
   * input where safe and emit `media.stream.ended` with this reason if input
   * has not already ended; error termination may discard buffered input.
   */
  close(reason: StreamEndReason): Promise<void>;
  /**
   * Resolves with the provider's confirmation for marked output. `true` means
   * the provider observed its playout condition before timeout; the evidence
   * varies by transport. A browser audio source ending confirms local scheduled
   * playback completed, but does not prove the caller heard it. Returns `false`
   * if the call dropped before confirmation. Optional: providers that cannot
   * observe playout omit it, and callers then fall back to "reached transport"
   * as their delivery signal.
   */
  confirmPlayout?(markId: string, timeoutMs: number): Promise<boolean>;
}

export interface TelephonyProvider extends Provider {
  readonly kind: "telephony";
  dial(request: OutboundCallRequest): Promise<CallHandle>;
  accept(ctx: InboundCallContext): Promise<CallHandle>;
  hangup(callId: CallId): Promise<void>;
}
