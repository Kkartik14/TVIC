import WebSocket from "ws";

import { PCM16_16K_MONO, PROVIDER_NAMES, TVIC_ERROR_CODES, TvicThrowableError } from "@tvic/core";
import type {
  CallHandle,
  CallId,
  InboundMediaEvent,
  OutboundCallRequest,
  OutputMediaEvent,
  ProviderCapabilities,
  SessionId,
  StreamEndReason,
  TelephonyProvider,
} from "@tvic/core";

import { providerError } from "./common.js";
import {
  TwilioMediaStreamCallHandle,
  type TwilioMediaStreamCallHandleOptions,
  type TwilioMediaStreamSocket,
} from "./twilio.js";
import {
  createTwilioCall,
  normalizeTwilioCallStatus,
  updateTwilioCall,
  validateTwilioRestOptions,
  type TwilioCallStatus,
  type TwilioRestOptions,
} from "./twilio-rest.js";

export const TWILIO_CAPABILITIES = {
  streaming: { input: true, output: true, native: true },
  cancellation: { request: true, output: true, buffer: true, truncation: false },
  transports: ["websocket"],
  audio: { input: [PCM16_16K_MONO], output: [PCM16_16K_MONO] },
  playout: { clearBuffer: true, acknowledgement: true, position: false },
} satisfies ProviderCapabilities;

const PENDING_ATTACH_TIMEOUT_MS = 30_000;

export interface TwilioMediaStreamsProviderOptions extends Partial<TwilioRestOptions> {
  /** HTTPS endpoint that verifies Twilio's webhook and returns Connect/Stream TwiML. */
  readonly twimlUrl?: string;
  /** HTTPS endpoint that receives signed call progress callbacks. */
  readonly statusCallbackUrl?: string;
  /** Bound how long an outbound call may wait for its Media Stream socket. */
  readonly streamConnectionTimeoutMs?: number;
  /** Twilio's maximum time to ring the destination before returning no-answer. */
  readonly answerTimeoutSeconds?: number;
}

interface DeferredValue<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

interface PendingTwilioDial {
  readonly request: OutboundCallRequest;
  readonly connected: DeferredValue<CallHandle>;
  readonly connectionTimer: ReturnType<typeof setTimeout>;
  callSid?: string;
  observedCallSid?: string;
  status: TwilioCallStatus;
  handle?: TwilioMediaStreamCallHandle;
  failure?: unknown;
  finished: boolean;
  settled: boolean;
}

/** Twilio Calls API dialer and host-authenticated Media Streams bridge. */
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
  readonly #pendingDials = new Map<CallId, PendingTwilioDial>();
  readonly #callSids = new Map<CallId, string>();
  readonly #options: TwilioMediaStreamsProviderOptions;

  constructor(options: TwilioMediaStreamsProviderOptions = {}) {
    this.#options = options;
  }

  async dial(request: OutboundCallRequest): Promise<CallHandle> {
    const config = this.#dialConfig();
    if (this.#pendingDials.has(request.callId) || this.#live.has(request.callId)) {
      throw TvicThrowableError.from(
        providerError("twilio.call_id_in_use", "Twilio call ID is already active", {
          provider: PROVIDER_NAMES.twilio,
          retriable: false,
          metadata: { callId: request.callId },
        }),
      );
    }

    const connected = deferredValue<CallHandle>();
    // A call may fail before any media socket exists. The returned handle's event
    // iterator observes this rejection; this handler prevents an unhandled
    // rejection if the caller has not started consuming it yet.
    void connected.promise.catch(() => undefined);
    const connectionTimer = setTimeout(() => {
      const pending = this.#pendingDials.get(request.callId);
      if (pending?.connected !== connected || pending.settled) return;
      this.#failPendingDial(
        pending,
        providerError(
          "twilio.media_stream_timeout",
          "Twilio call did not establish its Media Stream before the connection deadline",
          { provider: PROVIDER_NAMES.twilio, retriable: true },
        ),
      );
      if (pending.callSid) {
        void this.#terminateTwilioCall(pending.callSid, pending.status).catch(() => undefined);
      }
    }, config.streamConnectionTimeoutMs);
    connectionTimer.unref?.();

    const pending: PendingTwilioDial = {
      request,
      connected,
      connectionTimer,
      status: "queued",
      finished: false,
      settled: false,
    };
    this.#pendingDials.set(request.callId, pending);

    try {
      const callUrl = withCallContext(config.twimlUrl, request.callId, request.sessionId);
      const callbackUrl = withCallContext(
        config.statusCallbackUrl,
        request.callId,
        request.sessionId,
      );
      const body = new URLSearchParams({
        To: request.to,
        From: request.from,
        Url: callUrl,
        Method: "POST",
        StatusCallback: callbackUrl,
        StatusCallbackMethod: "POST",
        Timeout: String(config.answerTimeoutSeconds),
      });
      for (const event of ["initiated", "ringing", "answered", "completed"]) {
        body.append("StatusCallbackEvent", event);
      }

      const created = await createTwilioCall(config.rest, body);
      if (pending.failure !== undefined || pending.finished) {
        await this.#terminateTwilioCall(created.sid, pending.status).catch(() => undefined);
        throw (
          pending.failure ??
          providerFailure(
            "twilio.outbound_call_ended",
            "Twilio call ended before its Calls API request completed",
            false,
          )
        );
      }
      if (pending.observedCallSid && pending.observedCallSid !== created.sid) {
        const mismatch = providerFailure(
          "provider.identity_mismatch",
          "Twilio returned a different Call SID than its authenticated callback",
          false,
        );
        this.#failPendingDial(pending, mismatch);
        await this.#terminateTwilioCall(created.sid, pending.status).catch(() => undefined);
        throw mismatch;
      }
      pending.callSid = created.sid;
      if (pending.status === "queued") {
        pending.status = normalizeTwilioCallStatus(created.status) ?? "queued";
      }
      this.#callSids.set(request.callId, created.sid);
      return new PendingTwilioCallHandle(this, pending);
    } catch (error) {
      // Twilio can accept a call even when the REST response is lost. A signed
      // status callback or authenticated Media Stream carrying its Call SID is
      // proof that creation succeeded, so keep the SDK session attached instead
      // of inviting the caller to retry and place a duplicate call.
      if (pending.failure === undefined && !pending.finished && pending.observedCallSid) {
        pending.callSid = pending.observedCallSid;
        this.#callSids.set(request.callId, pending.callSid);
        return new PendingTwilioCallHandle(this, pending);
      }
      this.#failPendingDial(pending, error);
      throw error;
    }
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
      "expectedTwilioCallSid" | "expectedAccountSid" | "onClosed"
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
        if (this.#callSids.get(callId) === options.expectedTwilioCallSid) {
          this.#callSids.delete(callId);
        }
        options.onClosed?.();
      },
    });
    if (options.expectedTwilioCallSid) {
      this.#callSids.set(callId, options.expectedTwilioCallSid);
    }
    if (previous) void previous.close("cancelled").catch(() => undefined);
    this.#live.set(callId, handle);
    return handle;
  }

  /**
   * Delivers an authenticated outbound Twilio socket to the call created by
   * this provider. Returns false when the SDK has no matching outbound call;
   * hosts can reject that stale socket or route an uncorrelated inbound call.
   */
  async attachOutboundWebSocket(
    socket: TwilioMediaStreamSocket,
    callId: CallId,
    sessionId: SessionId,
    identity: { readonly callSid: string; readonly accountSid: string },
  ): Promise<boolean> {
    const pending = this.#pendingDials.get(callId);
    if (!pending) return false;
    if (pending.request.sessionId !== sessionId) {
      closeTwilioSocket(socket, "outbound session mismatch");
      this.#failPendingDial(
        pending,
        providerFailure(
          "provider.identity_mismatch",
          "Twilio stream session did not match the outbound call",
          false,
        ),
      );
      if (pending.callSid) {
        void this.#terminateTwilioCall(pending.callSid, pending.status).catch(() => undefined);
      }
      return true;
    }
    if (
      (pending.callSid && pending.callSid !== identity.callSid) ||
      (pending.observedCallSid && pending.observedCallSid !== identity.callSid)
    ) {
      closeTwilioSocket(socket, "outbound Call SID mismatch");
      this.#failPendingDial(
        pending,
        providerFailure(
          "provider.identity_mismatch",
          "Twilio stream Call SID did not match the outbound call",
          false,
        ),
      );
      if (pending.callSid) {
        void this.#terminateTwilioCall(pending.callSid, pending.status).catch(() => undefined);
      }
      return true;
    }
    if (this.#options.accountSid && identity.accountSid !== this.#options.accountSid) {
      closeTwilioSocket(socket, "outbound account mismatch");
      this.#failPendingDial(
        pending,
        providerFailure(
          "provider.identity_mismatch",
          "Twilio stream account did not match the configured account",
          false,
        ),
      );
      if (pending.callSid) {
        void this.#terminateTwilioCall(pending.callSid, pending.status).catch(() => undefined);
      }
      return true;
    }

    pending.observedCallSid = identity.callSid;
    // Twilio only starts a bidirectional Media Stream after the call is answered.
    // This also prevents a late Calls API response or stale `ringing` callback
    // from making hangup() try to cancel an already connected call.
    pending.status = "in-progress";
    const handle = await this.acceptWebSocket(socket, callId, sessionId, {
      expectedTwilioCallSid: identity.callSid,
      expectedAccountSid: identity.accountSid,
      onClosed: () => this.#finishPendingDial(pending),
    });
    pending.handle = handle;
    pending.settled = true;
    clearTimeout(pending.connectionTimer);
    pending.connected.resolve(handle);
    return true;
  }

  /** Receives a signature-verified Twilio StatusCallback from the host gateway. */
  receiveCallStatus(
    callId: CallId,
    sessionId: SessionId,
    callSid: string,
    value: unknown,
  ): boolean {
    const pending = this.#pendingDials.get(callId);
    if (!pending || pending.request.sessionId !== sessionId) return false;
    if (
      (pending.callSid && pending.callSid !== callSid) ||
      (pending.observedCallSid && pending.observedCallSid !== callSid)
    )
      return false;
    const status = normalizeTwilioCallStatus(value);
    if (!status) return false;
    if (isTerminalCallStatus(pending.status)) {
      // Twilio retries callbacks; delivery order is not a state transition.
      return true;
    }
    if (twilioStatusRank(status) < twilioStatusRank(pending.status)) {
      return true;
    }
    pending.observedCallSid = callSid;
    pending.status = status;
    if (isTerminalCallStatus(status)) {
      if (pending.handle) {
        // A terminal callback is authoritative even if the WebSocket close
        // notification is delayed or lost.
        void pending.handle
          .close(status === "completed" ? "completed" : "error")
          .catch(() => undefined);
      } else {
        this.#failPendingDial(
          pending,
          providerFailure(
            "twilio.outbound_call_failed",
            `Twilio outbound call ended before the media stream connected (${status})`,
            status === "failed" || status === "no-answer" || status === "busy",
          ),
        );
      }
    }
    return true;
  }

  getCallSid(callId: CallId): string | undefined {
    return this.#callSids.get(callId) ?? this.#pendingDials.get(callId)?.callSid;
  }

  async hangup(callId: CallId): Promise<void> {
    const pending = this.#pendingDials.get(callId);
    if (pending) {
      await this.#closePendingDial(pending, "cancelled");
      return;
    }
    const live = this.#live.get(callId);
    const callSid = this.#callSids.get(callId);
    try {
      if (callSid) await this.#updateCall(callSid, "completed");
    } finally {
      this.#callSids.delete(callId);
      if (live) await live.close("cancelled");
      const pendingSocket = this.#pendingSockets.get(callId);
      this.#pendingSockets.delete(callId);
      if (pendingSocket) {
        clearTimeout(pendingSocket.timer);
        closeTwilioSocket(pendingSocket.socket, "terminated");
      }
    }
  }

  async closePendingDial(pending: PendingTwilioDial, reason: StreamEndReason): Promise<void> {
    await this.#closePendingDial(pending, reason);
  }

  async #closePendingDial(pending: PendingTwilioDial, reason: StreamEndReason): Promise<void> {
    try {
      if (
        pending.callSid &&
        !pending.finished &&
        pending.failure === undefined &&
        !isTerminalCallStatus(pending.status)
      ) {
        await this.#terminateTwilioCall(pending.callSid, pending.status);
      }
    } finally {
      if (pending.handle) {
        await pending.handle.close(reason);
      } else {
        this.#failPendingDial(
          pending,
          providerFailure(
            "twilio.outbound_call_cancelled",
            "Twilio outbound call was cancelled",
            false,
          ),
        );
      }
    }
  }

  #failPendingDial(pending: PendingTwilioDial, error: unknown): void {
    if (pending.failure !== undefined || pending.finished) return;
    pending.failure = error;
    const rejectConnection = !pending.settled;
    pending.settled = true;
    clearTimeout(pending.connectionTimer);
    if (this.#pendingDials.get(pending.request.callId) === pending) {
      this.#pendingDials.delete(pending.request.callId);
    }
    if (this.#callSids.get(pending.request.callId) === pending.callSid) {
      this.#callSids.delete(pending.request.callId);
    }
    if (rejectConnection) pending.connected.reject(error);
    else if (pending.handle) void pending.handle.close("error").catch(() => undefined);
  }

  #finishPendingDial(pending: PendingTwilioDial): void {
    pending.finished = true;
    clearTimeout(pending.connectionTimer);
    if (this.#pendingDials.get(pending.request.callId) === pending) {
      this.#pendingDials.delete(pending.request.callId);
    }
    if (this.#callSids.get(pending.request.callId) === pending.callSid) {
      this.#callSids.delete(pending.request.callId);
    }
  }

  #dialConfig(): {
    readonly rest: TwilioRestOptions;
    readonly twimlUrl: string;
    readonly statusCallbackUrl: string;
    readonly streamConnectionTimeoutMs: number;
    readonly answerTimeoutSeconds: number;
  } {
    const { accountSid, authToken, apiKeySid, apiKeySecret, twimlUrl, statusCallbackUrl } =
      this.#options;
    if (!accountSid || !twimlUrl || !statusCallbackUrl) {
      throw providerFailure(
        "twilio.outbound_dial_not_configured",
        "Twilio dialing requires accountSid, twimlUrl, and statusCallbackUrl",
        false,
      );
    }
    const rest: TwilioRestOptions = {
      accountSid,
      ...(authToken ? { authToken } : {}),
      ...(apiKeySid ? { apiKeySid } : {}),
      ...(apiKeySecret ? { apiKeySecret } : {}),
    };
    try {
      validateTwilioRestOptions(rest);
      assertHttpsEndpoint(twimlUrl, "twimlUrl");
      assertHttpsEndpoint(statusCallbackUrl, "statusCallbackUrl");
    } catch (error) {
      throw providerFailure("twilio.outbound_dial_not_configured", errorMessage(error), false);
    }
    const answerTimeoutSeconds = this.#options.answerTimeoutSeconds ?? 60;
    if (
      !Number.isSafeInteger(answerTimeoutSeconds) ||
      answerTimeoutSeconds < 5 ||
      answerTimeoutSeconds > 600
    ) {
      throw providerFailure(
        "twilio.outbound_dial_not_configured",
        "answerTimeoutSeconds must be between 5 and 600",
        false,
      );
    }
    const streamConnectionTimeoutMs =
      this.#options.streamConnectionTimeoutMs ??
      Math.max(75_000, answerTimeoutSeconds * 1000 + 15_000);
    if (
      !Number.isSafeInteger(streamConnectionTimeoutMs) ||
      streamConnectionTimeoutMs < 15_000 ||
      streamConnectionTimeoutMs > 660_000
    ) {
      throw providerFailure(
        "twilio.outbound_dial_not_configured",
        "streamConnectionTimeoutMs must be between 15000 and 660000",
        false,
      );
    }
    return { rest, twimlUrl, statusCallbackUrl, streamConnectionTimeoutMs, answerTimeoutSeconds };
  }

  async #updateCall(callSid: string, status: "completed" | "canceled"): Promise<void> {
    const options = this.#restOptionsOrUndefined();
    if (!options) return;
    await updateTwilioCall(options, callSid, status);
  }

  async #terminateTwilioCall(callSid: string, status: TwilioCallStatus): Promise<void> {
    if (isTerminalCallStatus(status)) return;
    const twilioStatus =
      status === "queued" || status === "initiated" || status === "ringing"
        ? "canceled"
        : "completed";
    await this.#updateCall(callSid, twilioStatus);
  }

  #restOptionsOrUndefined(): TwilioRestOptions | undefined {
    const { accountSid, authToken, apiKeySid, apiKeySecret } = this.#options;
    if ((apiKeySid === undefined) !== (apiKeySecret === undefined)) {
      throw providerFailure(
        "twilio.rest_not_configured",
        "Twilio apiKeySid and apiKeySecret must be provided together",
        false,
      );
    }
    if (!accountSid || (!authToken && !(apiKeySid && apiKeySecret))) return undefined;
    const rest: TwilioRestOptions = {
      accountSid,
      ...(authToken ? { authToken } : {}),
      ...(apiKeySid ? { apiKeySid } : {}),
      ...(apiKeySecret ? { apiKeySecret } : {}),
    };
    try {
      validateTwilioRestOptions(rest);
    } catch (error) {
      throw providerFailure("twilio.rest_not_configured", errorMessage(error), false);
    }
    return rest;
  }
}

export function createTwilioMediaStreamsProvider(
  options?: TwilioMediaStreamsProviderOptions,
): TwilioMediaStreamsProvider {
  return new TwilioMediaStreamsProvider(options);
}

class PendingTwilioCallHandle implements CallHandle {
  readonly callId: CallId;
  readonly events: AsyncIterable<InboundMediaEvent>;
  readonly #provider: TwilioMediaStreamsProvider;
  readonly #pending: PendingTwilioDial;

  constructor(provider: TwilioMediaStreamsProvider, pending: PendingTwilioDial) {
    this.callId = pending.request.callId;
    this.#provider = provider;
    this.#pending = pending;
    this.events = (async function* (): AsyncGenerator<InboundMediaEvent> {
      const connected = await pending.connected.promise;
      yield* connected.events;
    })();
  }

  async send(event: OutputMediaEvent): Promise<boolean> {
    try {
      const connected = await this.#pending.connected.promise;
      return await connected.send(event);
    } catch {
      return false;
    }
  }

  async clear(): Promise<void> {
    const connected = await this.#pending.connected.promise.catch(() => undefined);
    if (connected) await connected.clear();
  }

  async close(reason: StreamEndReason): Promise<void> {
    await this.#provider.closePendingDial(this.#pending, reason);
  }

  async confirmPlayout(markId: string, timeoutMs: number): Promise<boolean> {
    const connected = await this.#pending.connected.promise.catch(() => undefined);
    if (!connected?.confirmPlayout) return false;
    return await connected.confirmPlayout(markId, timeoutMs);
  }
}

function deferredValue<T>(): DeferredValue<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function withCallContext(urlValue: string, callId: CallId, sessionId: SessionId): string {
  const url = new URL(urlValue);
  url.searchParams.set("tvicCallId", callId);
  url.searchParams.set("tvicSessionId", sessionId);
  return url.toString();
}

function assertHttpsEndpoint(value: string, field: string): void {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new TypeError(`${field} must be an HTTPS URL without embedded credentials`);
  }
}

function providerFailure(code: string, message: string, retriable: boolean): TvicThrowableError {
  return TvicThrowableError.from(
    providerError(code, message, { provider: PROVIDER_NAMES.twilio, retriable }),
  );
}

function isUnsuccessfulTerminalStatus(status: TwilioCallStatus): boolean {
  return (
    status === "busy" || status === "failed" || status === "no-answer" || status === "canceled"
  );
}

function isTerminalCallStatus(status: TwilioCallStatus): boolean {
  return isUnsuccessfulTerminalStatus(status) || status === "completed";
}

function twilioStatusRank(status: TwilioCallStatus): number {
  switch (status) {
    case "queued":
      return 0;
    case "initiated":
      return 1;
    case "ringing":
      return 2;
    case "in-progress":
      return 3;
    case "completed":
    case "busy":
    case "failed":
    case "no-answer":
    case "canceled":
      return 4;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
