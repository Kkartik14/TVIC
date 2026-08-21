import WebSocket from "ws";
import { describe, expect, it } from "vitest";

import { PCM16_16K_MONO } from "@tvic/core";
import type { CallHandle, CallId, OutputMediaEvent, SessionId, Timestamp } from "@tvic/core";

import {
  TwilioMediaStreamCallHandle,
  WebClientAudioCallHandle,
  type TwilioMediaStreamSocket,
  type WebClientAudioSocket,
} from "../src/index.js";

interface ContractFixture {
  readonly handle: CallHandle;
  readonly socket: ContractSocket;
  start(): void;
  drop(): void;
}

const adapters: ReadonlyArray<{
  readonly name: string;
  readonly create: (callId?: CallId, sessionId?: SessionId) => ContractFixture;
  readonly expectedFirstEventId: (callId: CallId) => string;
}> = [
  {
    name: "twilio",
    expectedFirstEventId: (callId) => `${callId}_twilio_event_1_stream_started_1`,
    create(callId = CALL_ID, sessionId = SESSION_ID) {
      const socket = new ContractSocket();
      return {
        socket,
        handle: new TwilioMediaStreamCallHandle({
          socket: socket as unknown as TwilioMediaStreamSocket,
          callId,
          sessionId,
          clock: { now: () => TS },
        }),
        start: () =>
          socket.text(JSON.stringify({ event: "start", sequenceNumber: "1", streamSid: "MZ1" })),
        drop: () => socket.drop(),
      };
    },
  },
  {
    name: "web-client-audio",
    expectedFirstEventId: (callId) => `${callId}_web_audio_event_1_stream_started`,
    create(callId = CALL_ID, sessionId = SESSION_ID) {
      const socket = new ContractSocket();
      return {
        socket,
        handle: new WebClientAudioCallHandle({
          socket: socket as unknown as WebClientAudioSocket,
          callId,
          sessionId,
          clock: { now: () => TS },
          heartbeatIntervalMs: 60_000,
        }),
        start: () =>
          socket.text(
            JSON.stringify({
              type: "session.start",
              protocolVersion: 1,
              mode: "continuous",
              clientPlatform: "contract-test",
              audioFormat: PCM16_16K_MONO,
            }),
          ),
        drop: () => socket.drop(),
      };
    },
  },
];

describe.each(adapters)("telephony contract: $name", ({ create, expectedFirstEventId }) => {
  it("surfaces stream start, accepts normalized output, and reports closed writes", async () => {
    const fixture = create();
    const next = fixture.handle.events[Symbol.asyncIterator]().next();
    fixture.start();
    expect((await next).value?.type).toBe("media.stream.started");
    expect(await fixture.handle.send(outputChunk())).toBe(true);
    await expect(fixture.handle.clear()).resolves.toBeUndefined();
    fixture.drop();
    expect(await fixture.handle.send(outputChunk())).toBe(false);
  });

  it("settles pending playout acknowledgement false when transport drops", async () => {
    const fixture = create();
    fixture.start();
    const pending = fixture.handle.confirmPlayout?.("missing", 1_000);
    expect(pending).toBeDefined();
    fixture.drop();
    await expect(pending).resolves.toBe(false);
  });

  it("times out an unacknowledged playout mark instead of hanging", async () => {
    const fixture = create();
    fixture.start();
    await expect(fixture.handle.confirmPlayout?.("missing", 5)).resolves.toBe(false);
  });

  it("keeps clear safe after close and makes close idempotent", async () => {
    const fixture = create();
    fixture.start();
    await fixture.handle.close("completed");
    await expect(fixture.handle.clear()).resolves.toBeUndefined();
    await expect(fixture.handle.close("completed")).resolves.toBeUndefined();
    expect(fixture.socket.closeCalls).toBe(1);
  });

  it("closes its event iterator cleanly when the transport closes", async () => {
    const fixture = create();
    fixture.start();
    const iterator = fixture.handle.events[Symbol.asyncIterator]();
    await iterator.next();
    fixture.drop();
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("namespaces handle-local event counters by call under a frozen clock", async () => {
    const firstCallId = "call_contract_1" as CallId;
    const secondCallId = "call_contract_2" as CallId;
    const first = create(firstCallId, "session_contract_1" as SessionId);
    const second = create(secondCallId, "session_contract_2" as SessionId);
    const firstEvent = first.handle.events[Symbol.asyncIterator]().next();
    const secondEvent = second.handle.events[Symbol.asyncIterator]().next();
    first.start();
    second.start();
    expect((await firstEvent).value?.id).toBe(expectedFirstEventId(firstCallId));
    expect((await secondEvent).value?.id).toBe(expectedFirstEventId(secondCallId));
    first.drop();
    second.drop();
  });
});

const CALL_ID = "call_contract" as CallId;
const SESSION_ID = "session_contract" as SessionId;
const TS = "2026-07-31T00:00:00.000Z" as Timestamp;

function outputChunk(): OutputMediaEvent {
  return {
    id: "media_contract" as never,
    type: "media.audio.chunk",
    sessionId: SESSION_ID,
    callId: CALL_ID,
    sequence: 1,
    direction: "output",
    timestamp: TS,
    monotonicOffsetMs: 0,
    audio: {
      format: PCM16_16K_MONO,
      durationMs: 20,
      frameCount: 320,
      bytes: new Uint8Array(640),
    },
  };
}

class ContractSocket {
  readyState: number = WebSocket.OPEN;
  closeCalls = 0;
  readonly #messages: Array<(data: WebSocket.RawData, isBinary: boolean) => void> = [];
  readonly #closes: Array<(...args: never[]) => void> = [];
  readonly #errors: Array<(error: Error) => void> = [];
  send(): void {}
  close(): void {
    this.closeCalls += 1;
    this.drop();
  }
  on(event: string, handler: (...args: never[]) => void): this {
    if (event === "message")
      this.#messages.push(handler as (data: WebSocket.RawData, isBinary: boolean) => void);
    else if (event === "close") this.#closes.push(handler);
    else this.#errors.push(handler as (error: Error) => void);
    return this;
  }
  text(value: string): void {
    for (const handler of this.#messages) handler(Buffer.from(value), false);
  }
  drop(): void {
    this.readyState = WebSocket.CLOSED;
    for (const handler of this.#closes) {
      (handler as (code: number, reason: Buffer) => void)(1006, Buffer.from("dropped"));
    }
  }
}
