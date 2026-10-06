export declare function encodePcmFrame(
  samples: Int16Array,
  sequence: number,
  offsetMs: number,
): ArrayBuffer;

export declare function decodePcmFrame(
  buffer: ArrayBuffer,
): { readonly sequence: number; readonly offsetMs: number; readonly samples: Int16Array } | null;

export type TvicVoiceMode = "push_to_talk" | "continuous";

export interface TvicVoiceConnectionDetail {
  readonly sessionRef: string;
  readonly expMs: number;
  readonly mode: TvicVoiceMode;
}

export interface TvicVoiceReadyDetail {
  readonly type: "session.ready";
  readonly sessionId: string;
  readonly callId: string;
  readonly mode: TvicVoiceMode;
  readonly heartbeatIntervalMs: number;
  readonly maxSessionDurationMs: number;
}

export type TvicVoiceClientError = Error & { readonly code?: string };

export interface TvicVoiceClientEventMap {
  readonly connected: CustomEvent<TvicVoiceConnectionDetail>;
  readonly ready: CustomEvent<TvicVoiceReadyDetail>;
  readonly transmitting: CustomEvent<boolean>;
  readonly "assistant-text": CustomEvent<{
    readonly type: "assistant.text";
    readonly turnId: string;
    readonly sequence: number;
    readonly text: string;
  }>;
  readonly audio: CustomEvent<{ readonly sequence: number; readonly durationMs: number }>;
  readonly pong: CustomEvent<{ readonly type: "server.pong"; readonly nonce?: string }>;
  readonly error: CustomEvent<TvicVoiceClientError>;
  readonly ended: CustomEvent<{ readonly type: "session.ended"; readonly reason: string }>;
  readonly "transport-closed": CustomEvent<CloseEvent>;
  readonly closed: CustomEvent<undefined>;
}

export declare class TvicVoiceClient extends EventTarget {
  constructor(options: {
    readonly gatewayUrl: string;
    readonly appToken: string;
    readonly mode: TvicVoiceMode;
    readonly path?: string;
    readonly clientPlatform?: string;
  });
  readonly connected: boolean;
  readonly mode: TvicVoiceMode;
  readonly lastSessionRef: string | undefined;
  readonly lastEndReason: string | undefined;
  readonly lastError: TvicVoiceClientError | undefined;
  connect(options?: { readonly supersedes?: string }): Promise<void>;
  startTurn(): void;
  endTurn(): void;
  interrupt(): void;
  close(): Promise<void>;
  addEventListener<K extends keyof TvicVoiceClientEventMap>(
    type: K,
    callback: ((this: TvicVoiceClient, event: TvicVoiceClientEventMap[K]) => void) | null,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener<K extends keyof TvicVoiceClientEventMap>(
    type: K,
    callback: ((this: TvicVoiceClient, event: TvicVoiceClientEventMap[K]) => void) | null,
    options?: boolean | EventListenerOptions,
  ): void;
}
