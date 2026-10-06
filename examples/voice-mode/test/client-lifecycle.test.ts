import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  decodePcmFrame,
  encodePcmFrame,
  TvicVoiceClient,
  type TvicVoiceClientError,
} from "../public/voice-client.js";

describe("browser voice client lifecycle", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    FakeWebSocket.autoOpen = true;
    FakeAudioContext.instances = [];
    FakeAudioContext.failWorklet = false;
    FakeAudioContext.workletStarted = false;
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
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("coalesces repeated close calls and emits closed once per connection", async () => {
    const client = new TvicVoiceClient({
      gatewayUrl: "http://localhost:8090",
      appToken: "app-token",
      mode: "push_to_talk",
    });
    const closed = vi.fn();
    client.addEventListener("closed", closed);

    await client.connect();
    const closing = client.close();
    await Promise.all([closing, client.close(), client.close()]);
    await client.close();
    expect(closed).toHaveBeenCalledTimes(1);

    await client.connect();
    await client.close();
    expect(closed).toHaveBeenCalledTimes(2);
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

  it("retains the terminal reason after cleanup without exposing the session token", async () => {
    const client = new TvicVoiceClient({
      gatewayUrl: "http://localhost:8090",
      appToken: "app-token",
      mode: "push_to_talk",
    });
    let connectionDetail: unknown;
    client.addEventListener("connected", (event) => {
      connectionDetail = event.detail;
    });

    await client.connect();
    expect(connectionDetail).toMatchObject({
      sessionRef: "session_1",
      mode: "push_to_talk",
    });
    expect(connectionDetail).not.toHaveProperty("token");

    FakeWebSocket.instances[0]?.emitMessage(
      JSON.stringify({ type: "session.ended", reason: "normal_completion" }),
    );
    await client.close();

    expect(client.lastEndReason).toBe("normal_completion");
  });

  it("preserves stable server error codes for browser consumers", async () => {
    const client = new TvicVoiceClient({
      gatewayUrl: "http://localhost:8090",
      appToken: "app-token",
      mode: "push_to_talk",
    });
    let receivedError: TvicVoiceClientError | undefined;
    client.addEventListener("error", (event) => {
      receivedError = event.detail;
    });

    await client.connect();
    FakeWebSocket.instances[0]?.emitMessage(
      JSON.stringify({ type: "session.error", code: "protocol_error", message: "Invalid frame" }),
    );

    expect(receivedError).toBeInstanceOf(Error);
    expect(receivedError?.message).toBe("Invalid frame");
    expect(receivedError?.code).toBe("protocol_error");
    const closed = new Promise<void>((resolve) => {
      client.addEventListener("closed", () => resolve(), { once: true });
    });
    FakeWebSocket.instances[0]?.close(4002, "protocol error");
    await closed;
    expect(client.lastError).toBe(receivedError);
  });

  it("acknowledges output only after the final audio source ends", async () => {
    const client = new TvicVoiceClient({
      gatewayUrl: "http://localhost:8090",
      appToken: "app-token",
      mode: "push_to_talk",
    });
    await client.connect();
    const socket = FakeWebSocket.instances[0];
    const context = FakeAudioContext.instances[0];
    expect(socket).toBeDefined();
    expect(context).toBeDefined();

    vi.useFakeTimers();
    if (context) context.state = "suspended";
    socket?.emitMessage(encodePcmFrame(new Int16Array(160), 1, 0));
    socket?.emitMessage(
      JSON.stringify({ type: "output.commit", commitId: "commit_1", sequenceRange: [1, 1] }),
    );

    await vi.advanceTimersByTimeAsync(100);
    expect(
      socket?.sent
        .filter((value): value is string => typeof value === "string")
        .map((value) => JSON.parse(value))
        .some((value) => value.type === "output.playout_ack"),
    ).toBe(false);

    context?.outputSources[0]?.finish();
    expect(
      socket?.sent
        .filter((value): value is string => typeof value === "string")
        .map((value) => JSON.parse(value))
        .find((value) => value.type === "output.playout_ack"),
    ).toEqual({ type: "output.playout_ack", commitId: "commit_1" });
    await client.close();
  });

  it("does not acknowledge output cancelled by clearing playback", async () => {
    const client = new TvicVoiceClient({
      gatewayUrl: "http://localhost:8090",
      appToken: "app-token",
      mode: "push_to_talk",
    });
    await client.connect();
    const socket = FakeWebSocket.instances[0];
    const context = FakeAudioContext.instances[0];
    socket?.emitMessage(encodePcmFrame(new Int16Array(160), 1, 0));
    socket?.emitMessage(
      JSON.stringify({
        type: "output.commit",
        commitId: "commit_cancelled",
        sequenceRange: [1, 1],
      }),
    );
    socket?.emitMessage(JSON.stringify({ type: "output.clear" }));
    context?.outputSources[0]?.finish();

    expect(
      socket?.sent
        .filter((value): value is string => typeof value === "string")
        .map((value) => JSON.parse(value))
        .some((value) => value.type === "output.playout_ack"),
    ).toBe(false);
    await client.close();
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
    await vi.waitFor(() => expect(FakeAudioContext.workletStarted).toBe(true));
    await client.close();
    FakeAudioContext.resolveWorklet?.();

    await expect(connecting).rejects.toThrow("Voice audio setup cancelled");
    expect(stream.stopped).toBeGreaterThan(0);
    expect(FakeAudioContext.instances[0]?.closed).toBe(true);
  });

  it("stops a microphone stream granted after connect is cancelled", async () => {
    let grantMicrophone: ((stream: ReturnType<typeof createMediaStream>) => void) | undefined;
    const getUserMedia = vi.fn(
      () =>
        new Promise<ReturnType<typeof createMediaStream>>((resolve) => {
          grantMicrophone = resolve;
        }),
    );
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia },
    });
    const client = new TvicVoiceClient({
      gatewayUrl: "http://localhost:8090",
      appToken: "app-token",
      mode: "push_to_talk",
    });
    const connecting = client.connect();
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());

    await client.close();
    await expect(connecting).rejects.toThrow("Voice connection closed");
    const lateStream = createMediaStream();
    grantMicrophone?.(lateStream);
    await Promise.resolve();
    expect(lateStream.stopped).toBe(1);
  });

  it("aborts a pending session mint when the client closes", async () => {
    let pendingMintSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: URL, init: RequestInit) => {
        pendingMintSignal = init.signal ?? undefined;
        return new Promise<Response>(() => undefined);
      }),
    );
    const client = new TvicVoiceClient({
      gatewayUrl: "http://localhost:8090",
      appToken: "app-token",
      mode: "push_to_talk",
    });
    const connecting = client.connect();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());

    await client.close();

    await expect(connecting).rejects.toThrow("Voice connection closed");
    expect(pendingMintSignal?.aborted).toBe(true);
  });

  it("closes a WebSocket while its handshake is still connecting", async () => {
    FakeWebSocket.autoOpen = false;
    const client = new TvicVoiceClient({
      gatewayUrl: "http://localhost:8090",
      appToken: "app-token",
      mode: "push_to_talk",
    });
    const connecting = client.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];

    await client.close();

    await expect(connecting).rejects.toThrow("Voice connection closed");
    expect(socket?.readyState).toBe(FakeWebSocket.CLOSED);
  });
});

const audioNodes: FakeAudioWorkletNode[] = [];

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  static autoOpen = true;
  readonly sent: Array<string | ArrayBuffer> = [];
  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | undefined;
  onerror: (() => void) | undefined;
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | undefined;
  onmessage: ((event: { readonly data: unknown }) => void) | undefined;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    if (FakeWebSocket.autoOpen) queueMicrotask(() => this.open());
  }

  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = "closed"): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  open(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
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
  static workletStarted = false;
  static workletReady: Promise<void> | undefined;
  static resolveWorklet: (() => void) | undefined;
  static instances: FakeAudioContext[] = [];
  readonly outputSources: FakeAudioBufferSource[] = [];
  readonly destination = {};
  readonly audioWorklet = {
    addModule: async () => {
      FakeAudioContext.workletStarted = true;
      if (FakeAudioContext.failWorklet) throw new Error("audio worklet setup failed");
      await FakeAudioContext.workletReady;
    },
  };
  currentTime = 0;
  state = "running";
  closed = false;

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  async resume(): Promise<void> {}

  createMediaStreamSource(_stream: unknown): FakeAudioNode {
    return new FakeAudioNode();
  }

  createBuffer(_channels: number, length: number, sampleRate: number): FakeAudioBuffer {
    return new FakeAudioBuffer(length, sampleRate);
  }

  createBufferSource(): FakeAudioBufferSource {
    const source = new FakeAudioBufferSource();
    this.outputSources.push(source);
    return source;
  }

  createGain(): FakeAudioNode & { readonly gain: { value: number } } {
    return Object.assign(new FakeAudioNode(), { gain: { value: 0 } });
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeAudioBuffer {
  readonly duration: number;
  readonly #channel: Float32Array;

  constructor(length: number, sampleRate: number) {
    this.duration = length / sampleRate;
    this.#channel = new Float32Array(length);
  }

  getChannelData(_channel: number): Float32Array {
    return this.#channel;
  }
}

class FakeAudioBufferSource {
  buffer: FakeAudioBuffer | undefined;
  onended: (() => void) | null = null;
  stopped = false;

  connect(): void {}
  disconnect(): void {}
  start(_when: number): void {}

  stop(): void {
    this.stopped = true;
  }

  finish(): void {
    this.onended?.();
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
