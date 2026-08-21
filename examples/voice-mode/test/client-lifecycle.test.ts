import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decodePcmFrame, TvicVoiceClient } from "../public/voice-client.js";

describe("browser voice client lifecycle", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    FakeAudioContext.instances = [];
    FakeAudioContext.failWorklet = false;
    FakeAudioContext.workletReady = undefined;
    FakeAudioContext.resolveWorklet = undefined;
    audioNodes.length = 0;
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn(async () => createMediaStream()) },
    });
    let sessionNumber = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        sessionNumber += 1;
        return {
          ok: true,
          async json() {
            return {
              sessionRef: `session_${sessionNumber}`,
              token: `token_${sessionNumber}`,
              expMs: Date.now() + 60_000,
              mode: "push_to_talk",
            };
          },
        };
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resets input framing and ignores stale transport callbacks on reconnect", async () => {
    const client = new TvicVoiceClient({
      gatewayUrl: "http://localhost:8090",
      appToken: "app-token",
      mode: "push_to_talk",
    });

    await client.connect();
    client.startTurn();
    audioNodes.at(-1)?.emit(new Int16Array([1, 2]));
    const firstSocket = FakeWebSocket.instances[0];
    expect(firstSocket).toBeDefined();
    const firstFrame = firstSocket?.sent.find((value) => value instanceof ArrayBuffer);
    expect(firstFrame && decodePcmFrame(firstFrame)?.sequence).toBe(1);

    await client.close();
    await client.connect();
    client.startTurn();
    audioNodes.at(-1)?.emit(new Int16Array([3, 4]));
    const secondSocket = FakeWebSocket.instances[1];
    expect(secondSocket).toBeDefined();
    const secondFrame = secondSocket?.sent.find((value) => value instanceof ArrayBuffer);
    expect(secondFrame && decodePcmFrame(secondFrame)?.sequence).toBe(1);

    firstSocket?.emitMessage(JSON.stringify({ type: "session.error", message: "stale" }));
    expect(client.connected).toBe(true);
  });

  it("cleans microphone and audio context when setup fails after permission", async () => {
    const stream = createMediaStream();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => stream) } });
    FakeAudioContext.failWorklet = true;
    const client = new TvicVoiceClient({
      gatewayUrl: "http://localhost:8090",
      appToken: "app-token",
      mode: "push_to_talk",
    });

    await expect(client.connect()).rejects.toThrow("audio worklet setup failed");
    expect(stream.stopped).toBe(1);
    expect(FakeAudioContext.instances[0]?.closed).toBe(true);
  });

  it("rolls back audio resources when setup is cancelled while loading the worklet", async () => {
    const stream = createMediaStream();
    const workletReady = new Promise<void>((resolve) => {
      FakeAudioContext.resolveWorklet = resolve;
    });
    FakeAudioContext.workletReady = workletReady;
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => stream) } });
    const client = new TvicVoiceClient({
      gatewayUrl: "http://localhost:8090",
      appToken: "app-token",
      mode: "push_to_talk",
    });

    const connecting = client.connect();
    await Promise.resolve();
    await client.close();
    FakeAudioContext.resolveWorklet?.();

    await expect(connecting).rejects.toThrow("Voice audio setup cancelled");
    expect(stream.stopped).toBeGreaterThan(0);
    expect(FakeAudioContext.instances[0]?.closed).toBe(true);
  });
});

const audioNodes: FakeAudioWorkletNode[] = [];

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readonly sent: Array<string | ArrayBuffer> = [];
  readonly url: string;
  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | undefined;
  onerror: (() => void) | undefined;
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | undefined;
  onmessage: ((event: { readonly data: unknown }) => void) | undefined;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }

  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = "closed"): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  emitMessage(data: unknown): void {
    this.onmessage?.({ data });
  }
}

class FakeAudioWorkletNode {
  readonly port: { onmessage: ((event: { readonly data: unknown }) => void) | null } = {
    onmessage: null,
  };

  constructor(_context: FakeAudioContext, _name: string) {
    audioNodes.push(this);
  }

  connect(): void {}
  disconnect(): void {}

  emit(data: unknown): void {
    this.port.onmessage?.({ data });
  }
}

class FakeAudioContext {
  static failWorklet = false;
  static workletReady: Promise<void> | undefined;
  static resolveWorklet: (() => void) | undefined;
  static instances: FakeAudioContext[] = [];
  readonly destination = {};
  readonly audioWorklet = {
    addModule: async () => {
      if (FakeAudioContext.failWorklet) throw new Error("audio worklet setup failed");
      await FakeAudioContext.workletReady;
    },
  };
  currentTime = 0;
  closed = false;

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  async resume(): Promise<void> {}

  createMediaStreamSource(_stream: unknown): FakeAudioNode {
    return new FakeAudioNode();
  }

  createGain(): FakeAudioNode & { readonly gain: { value: number } } {
    return Object.assign(new FakeAudioNode(), { gain: { value: 0 } });
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeAudioNode {
  connect(): void {}
  disconnect(): void {}
}

function createMediaStream(): { readonly stopped: number; getTracks(): Array<{ stop(): void }> } {
  let stopped = 0;
  return {
    get stopped() {
      return stopped;
    },
    getTracks() {
      return [{ stop: () => (stopped += 1) }];
    },
  };
}
