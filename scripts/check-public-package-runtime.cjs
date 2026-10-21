const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const requireFromProject = createRequire(`${process.cwd()}/package.json`);
const WebSocketModule = requireFromProject("ws");
const WebSocket = WebSocketModule.default ?? WebSocketModule;
const WebSocketServer = WebSocketModule.WebSocketServer;

async function loadApi() {
  return process.env.TVIC_PACKAGE_MODULE === "cjs"
    ? requireFromProject("voice-runtime")
    : import("voice-runtime");
}

async function within(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), 3_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function observeClient(client) {
  const jsonMessages = [];
  const binaryMessages = [];
  const waiters = new Set();
  client.on("message", (raw, isBinary) => {
    if (isBinary) {
      binaryMessages.push(Buffer.from(raw));
    } else {
      try {
        jsonMessages.push(JSON.parse(raw.toString("utf8")));
      } catch {}
    }
    for (const waiter of waiters) waiter();
  });
  return {
    jsonMessages,
    binaryMessages,
    waitForJson(predicate, label = "WebSocket JSON event") {
      const existing = jsonMessages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return within(
        new Promise((resolve) => {
          const check = () => {
            const found = jsonMessages.find(predicate);
            if (found) {
              waiters.delete(check);
              resolve(found);
            }
          };
          waiters.add(check);
        }),
        label,
      ).catch((error) => {
        throw new Error(`${error.message}; received ${JSON.stringify(jsonMessages)}`);
      });
    },
    waitForBinary() {
      if (binaryMessages.length > 0) return Promise.resolve(binaryMessages[0]);
      return within(
        new Promise((resolve) => {
          const check = () => {
            if (binaryMessages.length > 0) {
              waiters.delete(check);
              resolve(binaryMessages[0]);
            }
          };
          waiters.add(check);
        }),
        "WebSocket binary event",
      );
    },
  };
}

async function startServer() {
  const server = new WebSocketServer({ port: 0 });
  await within(new Promise((resolve) => server.once("listening", resolve)), "WebSocket server");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("WebSocket server has no port");
  return { server, port: address.port };
}

async function connectClient(port) {
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  await within(
    new Promise((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    }),
    "WebSocket client open",
  );
  return client;
}

function startMessage() {
  return JSON.stringify({
    type: "session.start",
    protocolVersion: 1,
    mode: "continuous",
    clientPlatform: "package-check",
    audioFormat: { encoding: "pcm_s16le", sampleRateHz: 16_000, channels: 1 },
  });
}

function inputAudioFrame() {
  const frame = Buffer.alloc(652);
  frame.writeUInt8(1, 0);
  frame.writeUInt32LE(1, 2);
  frame.set(Buffer.alloc(640), 12);
  return frame;
}

async function checkTransport(api) {
  const { server, port } = await startServer();
  let handle;
  let resolveHandle;
  const handleReady = new Promise((resolve) => {
    resolveHandle = resolve;
  });
  server.once("connection", (socket) => {
    handle = new api.WebClientAudioCallHandle({
      socket,
      callId: "package-call",
      sessionId: "package-session",
    });
    resolveHandle(handle);
  });
  const client = await connectClient(port);
  const observed = observeClient(client);
  try {
    const callHandle = await within(handleReady, "public call handle");
    const events = callHandle.events[Symbol.asyncIterator]();
    client.send(startMessage());
    const ready = await observed.waitForJson(
      (message) => message.type === "session.ready",
      "transport session.ready event",
    );
    assert.equal(ready.callId, "package-call");
    assert.equal(ready.sessionId, "package-session");

    const started = (await within(events.next(), "stream started event")).value;
    assert.equal(started.type, "media.stream.started");
    assert.equal(started.callId, "package-call");
    assert.equal(started.sessionId, "package-session");

    client.send(inputAudioFrame());
    const audio = (await within(events.next(), "input audio event")).value;
    assert.equal(audio.type, "media.audio.chunk");
    assert.equal(audio.callId, "package-call");
    assert.equal(audio.sessionId, "package-session");
    assert.equal(audio.sequence, 1);

    const sent = await callHandle.send({
      id: "package-output-audio",
      type: "media.audio.chunk",
      sessionId: "package-session",
      callId: "package-call",
      sequence: 1,
      direction: "output",
      timestamp: new Date().toISOString(),
      monotonicOffsetMs: 0,
      audio: {
        format: api.PCM16_16K_MONO,
        durationMs: 20,
        frameCount: 320,
        bytes: new Uint8Array(640),
      },
    });
    assert.equal(sent, true);
    const output = await observed.waitForBinary();
    assert.equal(output.readUInt32LE(2), 1);
    assert.equal(output.byteLength, 652);

    await callHandle.close("completed");
    const ended = await observed.waitForJson(
      (message) => message.type === "session.ended",
      "transport session.ended event",
    );
    assert.equal(ended.reason, "completed");
  } finally {
    if (handle) await handle.close("cancelled").catch(() => undefined);
    client.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
}

function createEventQueue() {
  const waiting = [];
  let closed = false;
  return {
    close() {
      closed = true;
      for (const resolve of waiting.splice(0)) resolve({ done: true, value: undefined });
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (closed) return Promise.resolve({ done: true, value: undefined });
          return new Promise((resolve) => waiting.push(resolve));
        },
        return() {
          closed = true;
          for (const resolve of waiting.splice(0)) resolve({ done: true, value: undefined });
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
}

function createProviders(capabilities, onSttOpen) {
  return {
    telephony: {
      name: "package-check-telephony",
      kind: "telephony",
      version: "1.0.0",
      capabilities,
      async dial() {
        throw new Error("dial was not expected");
      },
      async accept() {
        throw new Error("accept was not expected");
      },
      async hangup() {},
    },
    stt: {
      name: "package-check-stt",
      kind: "stt",
      version: "1.0.0",
      capabilities,
      async open() {
        onSttOpen();
        const events = createEventQueue();
        return {
          events,
          async sendAudio() {},
          async commit() {},
          async close() {
            events.close();
          },
        };
      },
    },
    llm: {
      name: "package-check-llm",
      kind: "llm",
      version: "1.0.0",
      capabilities,
      async complete() {
        throw new Error("LLM was not expected in a no-turn completion check");
      },
    },
    tts: {
      name: "package-check-tts",
      kind: "tts",
      version: "1.0.0",
      capabilities,
      async synthesize() {
        throw new Error("TTS was not expected in a no-turn completion check");
      },
    },
  };
}

async function checkManagedComplete(api) {
  const { server, port } = await startServer();
  let resolveSocket;
  const serverSocket = new Promise((resolve) => {
    resolveSocket = resolve;
  });
  server.once("connection", resolveSocket);
  const client = await connectClient(port);
  const observed = observeClient(client);
  let resolveSttOpen;
  const sttOpened = new Promise((resolve) => {
    resolveSttOpen = resolve;
  });
  const capabilities = {
    streaming: { input: true, output: true, native: true },
    cancellation: { request: true, output: true, buffer: true, truncation: true },
    transports: ["websocket"],
    audio: { input: [api.PCM16_16K_MONO], output: [api.PCM16_16K_MONO] },
    tools: { functionCalling: true, parallelCalls: true },
    playout: { clearBuffer: true, acknowledgement: true, position: true },
  };
  const agent = api.createVoiceAgent({
    prompt: "Complete the session without handling a turn.",
    providers: createProviders(capabilities, resolveSttOpen),
  });
  let session;
  try {
    const call = {
      id: "package-complete-call",
      provider: "web-client-audio",
      direction: "inbound",
      from: "browser",
      to: "agent",
      status: "connected",
      mediaTransport: { kind: "websocket", format: api.PCM16_16K_MONO },
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
    };
    session = await agent.start({
      call,
      channel: "web_audio",
      callHandle: async ({ sessionId }) =>
        new api.WebClientAudioCallHandle({
          socket: await serverSocket,
          callId: call.id,
          sessionId,
        }),
    });
    const run = session.run;
    void run.catch(() => undefined);
    client.send(startMessage());
    const ready = await observed.waitForJson(
      (message) => message.type === "session.ready",
      "managed session.ready event",
    );
    assert.equal(ready.sessionId, session.sessionId);
    await within(sttOpened, "STT stream open");
    await within(session.complete(), "managed session complete");
    await within(run, "managed session run");
    const ended = await observed.waitForJson(
      (message) => message.type === "session.ended",
      "managed session.ended event",
    );
    assert.equal(ended.reason, "completed");
    const finalSession = await within(session.finalSession, "final session record");
    assert.equal(finalSession.status, "completed");
    assert.equal(finalSession.terminalSource, "normal_completion");
    assert.deepEqual(finalSession.usage, { entries: [] });
  } finally {
    await session?.stop().catch(() => undefined);
    await agent.stop();
    client.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function main() {
  const api = await loadApi();
  await checkTransport(api);
  await checkManagedComplete(api);
  console.log(`public package runtime checks passed through ${process.env.TVIC_PACKAGE_MODULE}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
