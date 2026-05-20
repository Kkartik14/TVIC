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
  send(event: OutputMediaEvent): Promise<void>;
  close(reason: StreamEndReason): Promise<void>;
}

export interface TelephonyProvider extends Provider {
  readonly kind: "telephony";
  dial(request: OutboundCallRequest): Promise<CallHandle>;
  accept(ctx: InboundCallContext): Promise<CallHandle>;
  hangup(callId: CallId): Promise<void>;
}
