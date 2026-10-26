import WebSocket from "ws";
import { describe, expect, it } from "vitest";

import { PCM16_16K_MONO, type SttOpenRequest } from "@tvic/core";
import { AssemblyAiSttProvider } from "../src/assemblyai-stt.js";
import { ASSEMBLYAI_REALTIME_MODELS } from "../src/catalog.js";

class AssemblyAiProfileSocket {
  readonly #handlers = new Map<string, Set<(...values: unknown[]) => void>>();
  readyState: number = WebSocket.OPEN;

  on(event: string, handler: (...values: unknown[]) => void): this {
    const handlers = this.#handlers.get(event) ?? new Set();
    handlers.add(handler);
    this.#handlers.set(event, handlers);
    return this;
  }

  off(event: string, handler: (...values: unknown[]) => void): this {
    this.#handlers.get(event)?.delete(handler);
    return this;
  }

  send(data: string | Buffer, callback?: (error?: Error) => void): void {
    if (typeof data === "string" && JSON.parse(data).type === "Terminate") {
      queueMicrotask(() => this.receive({ type: "Termination", audio_duration_seconds: 0 }));
    }
    callback?.();
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.#emit("close", 1000, Buffer.alloc(0));
  }

  receive(message: unknown): void {
    this.#emit("message", Buffer.from(JSON.stringify(message)));
  }

  #emit(event: string, ...values: unknown[]): void {
    for (const handler of this.#handlers.get(event) ?? []) handler(...values);
  }
}

const baseRequest: SttOpenRequest = {
  sessionId: "session_profile_test" as never,
  format: PCM16_16K_MONO,
  interimResults: true,
};

describe("AssemblyAI turn profiles", () => {
  it.each([
    ["latency", "min_latency"],
    ["balanced", "balanced"],
    ["accuracy", "max_accuracy"],
  ] as const)("maps %s to AssemblyAI mode %s", async (turnProfile, mode) => {
    const socket = new AssemblyAiProfileSocket();
    let openedUrl = "";
    const provider = new AssemblyAiSttProvider({
      apiKey: "test",
      modelId: "universal-3-6-pro",
      webSocketFactory(url) {
        openedUrl = url;
        queueMicrotask(() => socket.receive({ type: "Begin", id: "profile-test" }));
        return socket as unknown as WebSocket;
      },
    });

    const stream = await provider.open({ ...baseRequest, turnProfile } as SttOpenRequest);

    expect(new URL(openedUrl).searchParams.get("mode")).toBe(mode);
    await stream.close();
  });

  it.each(ASSEMBLYAI_REALTIME_MODELS.filter((model) => model !== "universal-3-6-pro"))(
    "rejects profiles for unmapped realtime model %s before connecting",
    async (model) => {
      let connected = false;
      const provider = new AssemblyAiSttProvider({
        apiKey: "test",
        modelId: model,
        webSocketFactory() {
          connected = true;
          const socket = new AssemblyAiProfileSocket();
          queueMicrotask(() => socket.receive({ type: "Begin", id: "profile-test" }));
          return socket as unknown as WebSocket;
        },
      });

      await expect(
        provider.open({ ...baseRequest, turnProfile: "latency" } as SttOpenRequest),
      ).rejects.toMatchObject({
        category: "validation",
        metadata: {
          issues: [
            {
              code: "turn_profile.unsupported",
              requirement: "turnProfile",
            },
          ],
        },
      });
      expect(connected).toBe(false);
    },
  );
});
