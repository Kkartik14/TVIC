export declare function encodePcmFrame(
  samples: Int16Array,
  sequence: number,
  offsetMs: number,
): ArrayBuffer;

export declare function decodePcmFrame(
  buffer: ArrayBuffer,
): { readonly sequence: number; readonly offsetMs: number; readonly samples: Int16Array } | null;

export declare class TvicVoiceClient extends EventTarget {
  constructor(options: {
    readonly gatewayUrl: string;
    readonly appToken: string;
    readonly mode: "push_to_talk" | "continuous";
    readonly path?: string;
    readonly clientPlatform?: string;
  });
  readonly connected: boolean;
  readonly mode: "push_to_talk" | "continuous";
  connect(): Promise<void>;
  startTurn(): void;
  endTurn(): void;
  interrupt(): void;
  close(): Promise<void>;
}
