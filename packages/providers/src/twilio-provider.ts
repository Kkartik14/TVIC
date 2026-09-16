import WebSocket from "ws";

import { PCM16_16K_MONO, PROVIDER_NAMES, TVIC_ERROR_CODES, TvicThrowableError } from "@tvic/core";
import type {
  CallHandle,
  CallId,
  ProviderCapabilities,
  SessionId,
  TelephonyProvider,
} from "@tvic/core";

import { providerError } from "./common.js";
import {
  TwilioMediaStreamCallHandle,
  type TwilioMediaStreamCallHandleOptions,
  type TwilioMediaStreamSocket,
} from "./twilio.js";

export const TWILIO_CAPABILITIES = {
  streaming: { input: true, output: true, native: true },
  cancellation: { request: true, output: true, buffer: true, truncation: false },
  transports: ["websocket"],
  audio: { input: [PCM16_16K_MONO], output: [PCM16_16K_MONO] },
  playout: { clearBuffer: true, acknowledgement: true, position: false },
} satisfies ProviderCapabilities;

const PENDING_ATTACH_TIMEOUT_MS = 30_000;

/** Accept-only bridge for a host-authenticated Twilio Media Streams socket. */
export class TwilioMediaStreamsProvider implements TelephonyProvider {
  readonly name = PROVIDER_NAMES.twilio;
  readonly kind = "telephony";
  readonly version = "0.1.0";
  readonly capabilities = TWILIO_CAPABILITIES;
  readonly #pendingSockets = new Map<
    CallId,
    { socket: TwilioMediaStreamSocket; sessionId: SessionId; timer: ReturnType<typeof setTimeout> }
  >();
  readonly #live = new Map<CallId, TwilioMediaStreamCallHandle>();

  async dial(): Promise<CallHandle> {
    throw TvicThrowableError.from(
      providerError(
        "twilio.outbound_dial_unsupported",
        "Twilio outbound dialing is owned by the control plane; attach Media Streams via acceptWebSocket",
        { provider: PROVIDER_NAMES.twilio, retriable: false },
      ),
    );
  }

  async accept(ctx: Parameters<TelephonyProvider["accept"]>[0]): Promise<CallHandle> {
    const pending = this.#pendingSockets.get(ctx.call.id);
    if (!pending) {
      throw TvicThrowableError.from(
        providerError(
          "twilio.stream_socket_missing",
          `No attached Twilio Media Stream socket for call ${ctx.call.id}`,
          { provider: PROVIDER_NAMES.twilio, retriable: false },
        ),
      );
    }
    if (ctx.call.sessionId !== undefined && pending.sessionId !== ctx.call.sessionId) {
      this.#pendingSockets.delete(ctx.call.id);
      clearTimeout(pending.timer);
      closeTwilioSocket(pending.socket, "session mismatch");
      throw TvicThrowableError.from(
        providerError(
          TVIC_ERROR_CODES.providerIdentityMismatch,
          `Attached Twilio Media Stream socket session does not match runtime session for call ${ctx.call.id}`,
          {
            provider: PROVIDER_NAMES.twilio,
            retriable: false,
            metadata: {
              callId: ctx.call.id,
              pendingSessionId: pending.sessionId,
              runtimeSessionId: ctx.call.sessionId,
            },
          },
        ),
      );
    }
    const sessionId = ctx.call.sessionId ?? pending.sessionId;
    this.#pendingSockets.delete(ctx.call.id);
    clearTimeout(pending.timer);
    return this.acceptWebSocket(
      pending.socket,
      ctx.call.id,
      sessionId,
      expectedTwilioIdentity(ctx.call.metadata),
    );
  }

  attachWebSocket(socket: TwilioMediaStreamSocket, callId: CallId, sessionId: SessionId): void {
    const previous = this.#pendingSockets.get(callId);
    if (previous?.socket === socket && previous.sessionId === sessionId) return;
    if (previous) {
      this.#pendingSockets.delete(callId);
      clearTimeout(previous.timer);
      closeTwilioSocket(previous.socket, "superseded");
    }
    if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) return;
    const timer = setTimeout(() => {
      if (this.#pendingSockets.get(callId)?.socket !== socket) return;
      this.#pendingSockets.delete(callId);
      closeTwilioSocket(socket, "accept timeout");
    }, PENDING_ATTACH_TIMEOUT_MS);
    timer.unref?.();
    this.#pendingSockets.set(callId, { socket, sessionId, timer });
    socket.on("close", () => {
      const pending = this.#pendingSockets.get(callId);
      if (pending?.socket === socket) {
        clearTimeout(pending.timer);
        this.#pendingSockets.delete(callId);
      }
    });
  }

  async acceptWebSocket(
    socket: TwilioMediaStreamSocket,
    callId: CallId,
    sessionId: SessionId,
    options: Pick<
      TwilioMediaStreamCallHandleOptions,
      "expectedTwilioCallSid" | "expectedAccountSid"
    > = {},
  ): Promise<TwilioMediaStreamCallHandle> {
    const previous = this.#live.get(callId);
    let handle!: TwilioMediaStreamCallHandle;
    handle = new TwilioMediaStreamCallHandle({
      socket,
      callId,
      sessionId,
      ...options,
      onClosed: () => {
        if (this.#live.get(callId) === handle) this.#live.delete(callId);
      },
    });
    if (previous) void previous.close("cancelled").catch(() => undefined);
    this.#live.set(callId, handle);
    return handle;
  }

  async hangup(callId: CallId): Promise<void> {
    const live = this.#live.get(callId);
    if (live) await live.close("remote_hangup");
    const pending = this.#pendingSockets.get(callId);
    this.#pendingSockets.delete(callId);
    if (pending) {
      clearTimeout(pending.timer);
      closeTwilioSocket(pending.socket, "terminated");
    }
  }
}

export function createTwilioMediaStreamsProvider(): TwilioMediaStreamsProvider {
  return new TwilioMediaStreamsProvider();
}

function expectedTwilioIdentity(
  metadata: Readonly<Record<string, unknown>> | undefined,
): Pick<TwilioMediaStreamCallHandleOptions, "expectedTwilioCallSid" | "expectedAccountSid"> {
  const callSid = metadata?.twilioCallSid;
  const accountSid = metadata?.accountSid;
  return {
    ...(typeof callSid === "string" && callSid.length > 0
      ? { expectedTwilioCallSid: callSid }
      : {}),
    ...(typeof accountSid === "string" && accountSid.length > 0
      ? { expectedAccountSid: accountSid }
      : {}),
  };
}

function closeTwilioSocket(socket: TwilioMediaStreamSocket, reason: string): void {
  try {
    socket.close(1000, reason);
  } catch {
    // Pending transport teardown is best-effort.
  }
}
