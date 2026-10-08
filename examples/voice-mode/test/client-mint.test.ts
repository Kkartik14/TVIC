import { afterEach, describe, expect, it, vi } from "vitest";

import { TvicVoiceClient } from "../public/voice-client.js";

afterEach(() => vi.unstubAllGlobals());

describe("browser voice client session minting", () => {
  it("supports reconnecting by superseding a known session and keeps its reference after close", async () => {
    const stream = { getTracks: () => [{ stop() {} }] };
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: async () => stream },
    });
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);

    let socket: FakeWebSocket | undefined;
    class TestWebSocket extends FakeWebSocket {
      constructor(url: string) {
        super(url);
        socket = this;
      }
    }
    vi.stubGlobal("WebSocket", Object.assign(TestWebSocket, { OPEN: 1 }));

    const fetchMock = vi.fn(async (_url: URL, init: RequestInit) => ({
      ok: true,
      status: 201,
      async json() {
        expect(JSON.parse(String(init.body))).toEqual({
          mode: "push_to_talk",
          supersedes: "prior-session",
        });
        return {
          sessionRef: "replacement-session",
          token: "single-use-token",
          expMs: 10_000,
          mode: "push_to_talk",
        };
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new TvicVoiceClient({
      gatewayUrl: "https://voice.example",
      appToken: "application-token",
      mode: "push_to_talk",
    });

    await client.connect({ supersedes: "prior-session" });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(socket?.sent).toHaveLength(1);
    expect(client.lastSessionRef).toBe("replacement-session");
    await client.close();
    expect(client.lastSessionRef).toBe("replacement-session");
  });

  it("retries without a stale superseded reference", async () => {
    const stream = { getTracks: () => [{ stop() {} }] };
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: async () => stream },
    });
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);

    class TestWebSocket extends FakeWebSocket {}
    vi.stubGlobal("WebSocket", Object.assign(TestWebSocket, { OPEN: 1 }));

    const fetchMock = vi.fn(async (_url: URL, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      if (request.supersedes) {
        return {
          ok: false,
          status: 403,
          async json() {
            return { error: "invalid_supersedes" };
          },
        };
      }
      return {
        ok: true,
        status: 201,
        async json() {
          return {
            sessionRef: "fresh-session",
            token: "single-use-token",
            expMs: 10_000,
            mode: "push_to_talk",
          };
        },
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new TvicVoiceClient({
      gatewayUrl: "https://voice.example",
      appToken: "application-token",
      mode: "push_to_talk",
    });

    await client.connect({ supersedes: "stale-session" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      mode: "push_to_talk",
      supersedes: "stale-session",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      mode: "push_to_talk",
    });
    expect(client.lastSessionRef).toBe("fresh-session");
    await client.close();
  });
});

class FakeAudioContext {
  readonly destination = {};
  readonly audioWorklet = { async addModule() {} };
  currentTime = 0;

  async resume() {}

  createMediaStreamSource() {
    return { connect() {}, disconnect() {} };
  }

  createGain() {
    return { gain: { value: 1 }, connect() {}, disconnect() {} };
  }

  async close() {}
}

class FakeAudioWorkletNode {
  readonly port = { onmessage: null };

  constructor(_context: FakeAudioContext, _name: string) {}

  connect() {}

  disconnect() {}
}

class FakeWebSocket {
  static readonly OPEN = 1;
  readonly sent: string[] = [];
  readyState = 0;
  onopen?: () => void;
  onerror?: () => void;
  onclose?: (event: { readonly code: number }) => void;
  onmessage?: (event: { readonly data: string | ArrayBuffer | Blob }) => void;

  constructor(_url: string) {
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
    });
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
}
