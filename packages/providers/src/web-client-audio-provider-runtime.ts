import WebSocket from "ws";
import type {
  CallHandle,
  CallId,
  ProviderCapabilities,
  SessionId,
  TelephonyProvider,
} from "@tvic/core";
import {
  PCM16_16K_MONO,
  PROVIDER_NAMES,
  TVIC_ERROR_CODES,
  TvicThrowableError,
  providerError,
} from "@tvic/core";

import type {
  WebClientAudioCallHandle,
  WebClientAudioProviderOptions,
  WebClientAudioSocket,
} from "./web-client-audio.js";
import {
  WebClientAudioCallHandle as RuntimeWebClientAudioCallHandle,
  WEB_CLIENT_AUDIO_CLOSE_CODES,
  closeSocket,
} from "./web-client-audio-runtime.js";

const CAPABILITIES = {
  streaming: { input: true, output: true, native: true },
  cancellation: { request: true, output: true, buffer: true, truncation: false },
  transports: ["websocket"],
  audio: { input: [PCM16_16K_MONO], output: [PCM16_16K_MONO] },
  playout: { clearBuffer: true, acknowledgement: true, position: false },
} as const satisfies ProviderCapabilities;

const PENDING_ACCEPT_TIMEOUT_MS = 30_000;

interface PendingSocket {
  readonly socket: WebClientAudioSocket;
  readonly sessionId: SessionId;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class WebClientAudioProvider implements TelephonyProvider {
  name: "web-client-audio" = PROVIDER_NAMES.webClientAudio;
  kind: "telephony" = "telephony";
  version: "0.1.0" = "0.1.0";
  capabilities: ProviderCapabilities = CAPABILITIES;
  #options: WebClientAudioProviderOptions;
  #pending = new Map<CallId, PendingSocket>();
  #live = new Map<CallId, WebClientAudioCallHandle>();

  constructor(options: WebClientAudioProviderOptions = {}) {
    this.#options = options;
  }

  async dial(): Promise<CallHandle> {
    throw TvicThrowableError.from(
      providerError("web_client_audio.dial_unsupported", "Web client audio is accept-only", {
        provider: PROVIDER_NAMES.webClientAudio,
        retriable: false,
      }),
    );
  }

  async accept(ctx: Parameters<TelephonyProvider["accept"]>[0]): Promise<CallHandle> {
    const pending = this.#pending.get(ctx.call.id);
    if (!pending) {
      throw TvicThrowableError.from(
        providerError(
          "web_client_audio.socket_missing",
          `No attached socket for call ${ctx.call.id}`,
          { provider: PROVIDER_NAMES.webClientAudio, retriable: false },
        ),
      );
    }
    if (ctx.call.sessionId !== undefined && pending.sessionId !== ctx.call.sessionId) {
      this.#pending.delete(ctx.call.id);
      clearTimeout(pending.timer);
      closeSocket(pending.socket, WEB_CLIENT_AUDIO_CLOSE_CODES.protocol, "session mismatch");
      throw TvicThrowableError.from(
        providerError(
          TVIC_ERROR_CODES.providerIdentityMismatch,
          `Attached Web Client socket session does not match runtime session for call ${ctx.call.id}`,
          {
            provider: PROVIDER_NAMES.webClientAudio,
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
    this.#pending.delete(ctx.call.id);
    clearTimeout(pending.timer);
    return this.acceptWebSocket(pending.socket, ctx.call.id, sessionId);
  }

  attachWebSocket(socket: WebClientAudioSocket, callId: CallId, sessionId: SessionId): void {
    const previous = this.#pending.get(callId);
    if (previous?.socket === socket) return;
    if (previous?.socket !== socket) {
      this.#pending.delete(callId);
      if (previous) {
        clearTimeout(previous.timer);
        closeSocket(previous.socket, WEB_CLIENT_AUDIO_CLOSE_CODES.superseded, "superseded");
      }
    }
    if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) return;
    const timer = setTimeout(() => {
      if (this.#pending.get(callId)?.socket !== socket) return;
      this.#pending.delete(callId);
      closeSocket(socket, WEB_CLIENT_AUDIO_CLOSE_CODES.heartbeatTimeout, "accept timeout");
    }, PENDING_ACCEPT_TIMEOUT_MS);
    timer.unref?.();
    this.#pending.set(callId, { socket, sessionId, timer });
    socket.on("close", () => {
      const pending = this.#pending.get(callId);
      if (pending?.socket === socket) {
        clearTimeout(pending.timer);
        this.#pending.delete(callId);
      }
    });
    if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) {
      const pending = this.#pending.get(callId);
      if (pending?.socket === socket) {
        clearTimeout(pending.timer);
        this.#pending.delete(callId);
      }
    }
  }

  async acceptWebSocket(
    socket: WebClientAudioSocket,
    callId: CallId,
    sessionId: SessionId,
    connectionOptions: { readonly expectedMode?: "push_to_talk" | "continuous" } = {},
  ): Promise<WebClientAudioCallHandle> {
    this.#live
      .get(callId)
      ?.terminate(WEB_CLIENT_AUDIO_CLOSE_CODES.superseded, "superseded by reconnect");
    let handle: WebClientAudioCallHandle;
    handle = new RuntimeWebClientAudioCallHandle({
      ...this.#options,
      socket,
      callId,
      sessionId,
      ...connectionOptions,
      onClosed: () => {
        if (this.#live.get(callId) === handle) this.#live.delete(callId);
      },
    });
    this.#live.set(callId, handle);
    return handle;
  }

  async hangup(callId: CallId): Promise<void> {
    this.#live
      .get(callId)
      ?.terminate(WEB_CLIENT_AUDIO_CLOSE_CODES.operatorTerminated, "terminated");
    const pending = this.#pending.get(callId);
    this.#pending.delete(callId);
    if (pending) {
      clearTimeout(pending.timer);
      closeSocket(pending.socket, WEB_CLIENT_AUDIO_CLOSE_CODES.operatorTerminated, "terminated");
    }
  }

  async supersede(callId: CallId): Promise<void> {
    this.#live
      .get(callId)
      ?.terminate(WEB_CLIENT_AUDIO_CLOSE_CODES.superseded, "superseded by reconnect");
    const pending = this.#pending.get(callId);
    this.#pending.delete(callId);
    if (pending) {
      clearTimeout(pending.timer);
      closeSocket(
        pending.socket,
        WEB_CLIENT_AUDIO_CLOSE_CODES.superseded,
        "superseded by reconnect",
      );
    }
  }
}

export function createWebClientAudioProvider(
  options: WebClientAudioProviderOptions = {},
): WebClientAudioProvider {
  return new WebClientAudioProvider(options);
}
