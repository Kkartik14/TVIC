import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageDirectory = path.join(repositoryRoot, "packages", "voice-runtime");
const packageManifest = JSON.parse(
  await readFile(path.join(packageDirectory, "package.json"), "utf8"),
);
const smokeDirectory = await mkdtemp(path.join(tmpdir(), "voice-runtime-package-"));

try {
  await execFileAsync(
    "npm",
    ["pack", "--pack-destination", smokeDirectory, "--json", "--ignore-scripts"],
    { cwd: packageDirectory },
  );

  const tarballName = `${packageManifest.name.replaceAll("/", "-")}-${packageManifest.version}.tgz`;
  const tarball = path.join(smokeDirectory, tarballName);
  const projectDirectory = path.join(smokeDirectory, "project");
  await mkdir(projectDirectory);
  await execFileAsync("npm", ["init", "-y"], { cwd: projectDirectory });
  await execFileAsync("npm", ["install", tarball, "--no-audit", "--no-fund", "--ignore-scripts"], {
    cwd: projectDirectory,
  });

  const esmCheck = [
    'const pkg = await import("voice-runtime");',
    'for (const name of ["createVoiceAgent", "createRuntime", "defineAgent", "runPostgresMigrations", "runPostgresMemoryMigrations"]) {',
    '  if (typeof pkg[name] !== "function") throw new Error(`missing ESM export: ${name}`);',
    "}",
    'if (pkg.PROVIDER_STABILITY?.webClientAudio !== "stable") throw new Error("missing provider maturity labels");',
    'console.log("external ESM import ok");',
  ].join("\n");
  await execFileAsync("node", ["--input-type=module", "-e", esmCheck], {
    cwd: projectDirectory,
  });

  const commonJsCheck = [
    'const pkg = require("voice-runtime");',
    'for (const name of ["createVoiceAgent", "createRuntime", "defineAgent", "runPostgresMigrations", "runPostgresMemoryMigrations"]) {',
    '  if (typeof pkg[name] !== "function") throw new Error(`missing CJS export: ${name}`);',
    "}",
    'if (pkg.PROVIDER_STABILITY?.twilio !== "stable") throw new Error("missing CJS provider maturity labels");',
    'console.log("external CJS require ok");',
  ].join("\n");
  await execFileAsync("node", ["-e", commonJsCheck], { cwd: projectDirectory });

  const transportCheck = [
    'const pkg = await import("voice-runtime");',
    "class FakeSocket {",
    "  readyState = 1;",
    "  handlers = new Map();",
    "  sent = [];",
    "  on(event, handler) { this.handlers.set(event, handler); return this; }",
    "  send(data) { this.sent.push(data); }",
    '  close(code = 1000, reason = "") {',
    "    this.readyState = 3;",
    '    this.handlers.get("close")?.(code, Buffer.from(reason));',
    "  }",
    "  message(data, isBinary = false) {",
    '    this.handlers.get("message")?.(Buffer.from(data), isBinary);',
    "  }",
    "}",
    "const webSocket = new FakeSocket();",
    'const web = new pkg.WebClientAudioCallHandle({ socket: webSocket, callId: "public-web-call", sessionId: "public-web-session", heartbeatIntervalMs: 60_000, heartbeatTimeoutMs: 60_000 });',
    "const webEvent = web.events[Symbol.asyncIterator]().next();",
    'webSocket.message(JSON.stringify({ type: "session.start", protocolVersion: 1, mode: "continuous", clientPlatform: "public-smoke", audioFormat: pkg.PCM16_16K_MONO }));',
    'if ((await webEvent).value?.type !== "media.stream.started") throw new Error("public Web Client Audio handle did not start");',
    'await web.close("completed");',
    "const twilioSocket = new FakeSocket();",
    'const twilio = new pkg.TwilioMediaStreamCallHandle({ socket: twilioSocket, callId: "public-twilio-call", sessionId: "public-twilio-session" });',
    "const twilioEvent = twilio.events[Symbol.asyncIterator]().next();",
    'twilioSocket.message(JSON.stringify({ event: "start", sequenceNumber: "1", streamSid: "MZ-public" }));',
    'if ((await twilioEvent).value?.type !== "media.stream.started") throw new Error("public Twilio handle did not start");',
    'await twilio.close("completed");',
    'console.log("public transport handles ok");',
  ].join("\n");
  await execFileAsync("node", ["--input-type=module", "-e", transportCheck], {
    cwd: projectDirectory,
  });

  const migrationCheck = [
    "(async () => {",
    'const pkg = require("voice-runtime");',
    "function fakePool() {",
    "  return {",
    "    async query() { return { rows: [], rowCount: 0 }; },",
    "    async connect() {",
    "      return {",
    "        async query(text) {",
    '          if (text.includes("SELECT version")) return { rows: [], rowCount: 0 };',
    "          return { rows: [], rowCount: 1 };",
    "        },",
    "        release() {},",
    "      };",
    "    },",
    "  };",
    "}",
    "const durable = await pkg.runPostgresMigrations(fakePool());",
    "const memory = await pkg.runPostgresMemoryMigrations(fakePool());",
    'if (durable.join(",") !== "1,2,3") throw new Error(`unexpected durable migrations: ${durable}`);',
    'if (memory.join(",") !== "1,2") throw new Error(`unexpected memory migrations: ${memory}`);',
    'console.log("bundled migration execution ok");',
    "})().catch((error) => { console.error(error); process.exit(1); });",
  ].join("\n");
  await execFileAsync("node", ["-e", migrationCheck], {
    cwd: projectDirectory,
  });

  const managedCheck = [
    'const pkg = await import("voice-runtime");',
    "const capabilities = {",
    "  streaming: { input: true, output: true, native: true },",
    "  cancellation: { request: true, output: true, buffer: true, truncation: true },",
    '  transports: ["websocket"],',
    "  audio: { input: [pkg.PCM16_16K_MONO], output: [pkg.PCM16_16K_MONO] },",
    "  tools: { functionCalling: true, parallelCalls: true },",
    "  playout: { clearBuffer: true, acknowledgement: true, position: true },",
    "};",
    "const inbound = new pkg.AsyncQueue();",
    "let resolveOpened;",
    "const opened = new Promise((resolve) => { resolveOpened = resolve; });",
    "const callHandle = {",
    '  callId: "packed-call",',
    "  events: inbound,",
    "  async send() { return true; },",
    "  async clear() {},",
    "  async close() { inbound.close(); },",
    "};",
    "const call = {",
    '  id: "packed-call", provider: "packed-telephony", direction: "inbound",',
    '  from: "caller", to: "voice-agent", status: "connected",',
    '  mediaTransport: { kind: "websocket", format: pkg.PCM16_16K_MONO },',
    "  createdAt: pkg.nowTimestamp(), startedAt: pkg.nowTimestamp(),",
    "};",
    'const stt = { name: "packed-stt", kind: "stt", version: "1.0.0", capabilities,',
    "  async open() {",
    "    resolveOpened();",
    "    const events = new pkg.AsyncQueue();",
    "    return { events, async sendAudio() {}, async commit() {}, async close() { events.close(); } };",
    "  },",
    "};",
    'const llm = { name: "packed-llm", kind: "llm", version: "1.0.0", capabilities,',
    '  async complete() { throw new Error("LLM should not run for an empty stream"); },',
    "};",
    'const tts = { name: "packed-tts", kind: "tts", version: "1.0.0", capabilities,',
    '  async synthesize() { throw new Error("TTS should not run for an empty stream"); },',
    "};",
    'const telephony = { name: "packed-telephony", kind: "telephony", version: "1.0.0", capabilities,',
    '  async dial() { throw new Error("dial should not run"); },',
    '  async accept() { throw new Error("accept should not run"); },',
    "  async hangup() {},",
    "};",
    'const agent = pkg.createVoiceAgent({ prompt: "Handle a short call.", providers: { telephony, stt, llm, tts } });',
    'const session = await agent.start({ call, callHandle: async ({ sessionId }) => { if (!sessionId) throw new Error("missing managed session id"); return callHandle; }, channel: "simulated" });',
    "await opened;",
    'inbound.push(pkg.createMediaEvent({ id: "packed-start", type: "media.stream.started", sessionId: session.sessionId, sequence: 1, direction: "input", timestamp: pkg.nowTimestamp(), monotonicOffsetMs: 0, format: pkg.PCM16_16K_MONO }));',
    "inbound.close();",
    "const result = await session.run;",
    "if (result.turnsHandled !== 0) throw new Error(`unexpected empty-stream turns: ${result.turnsHandled}`);",
    "await agent.stop();",
    'console.log("packed managed session ok");',
  ].join("\n");
  await execFileAsync("node", ["--input-type=module", "-e", managedCheck], {
    cwd: projectDirectory,
  });

  const managedTransportCheck = [
    'const pkg = await import("voice-runtime");',
    "class FakeSocket {",
    "  readyState = 1;",
    "  handlers = new Map();",
    "  sent = [];",
    "  on(event, handler) { this.handlers.set(event, handler); return this; }",
    "  send(data) { this.sent.push(data); }",
    '  close(code = 1000, reason = "") {',
    "    if (this.readyState === 3) return;",
    "    this.readyState = 3;",
    '    this.handlers.get("close")?.(code, Buffer.from(reason));',
    "  }",
    "  message(data, isBinary = false) {",
    '    this.handlers.get("message")?.(Buffer.from(data), isBinary);',
    "  }",
    "}",
    "const capabilities = {",
    "  streaming: { input: true, output: true, native: true },",
    "  cancellation: { request: true, output: true, buffer: true, truncation: true },",
    '  transports: ["websocket"],',
    "  audio: { input: [pkg.PCM16_16K_MONO], output: [pkg.PCM16_16K_MONO] },",
    "  tools: { functionCalling: true, parallelCalls: true },",
    "  playout: { clearBuffer: true, acknowledgement: true, position: true },",
    "};",
    "const transcripts = new pkg.AsyncQueue();",
    "let resolveOpened;",
    "const opened = new Promise((resolve) => { resolveOpened = resolve; });",
    'const stt = { name: "packed-transport-stt", kind: "stt", version: "1.0.0", capabilities,',
    "  async open() {",
    "    resolveOpened();",
    "    return { events: transcripts, async sendAudio() {}, async commit() {}, async close() { transcripts.close(); } };",
    "  },",
    "};",
    'const llm = { name: "packed-transport-llm", kind: "llm", version: "1.0.0", capabilities, async complete() { throw new Error("LLM should not run"); } };',
    'const tts = { name: "packed-transport-tts", kind: "tts", version: "1.0.0", capabilities, async synthesize() { throw new Error("TTS should not run"); } };',
    "const socket = new FakeSocket();",
    'const call = { id: "packed-web-call", provider: "web-client-audio", direction: "inbound", from: "browser", to: "voice-agent", status: "connected", mediaTransport: { kind: "websocket", format: pkg.PCM16_16K_MONO }, createdAt: pkg.nowTimestamp(), startedAt: pkg.nowTimestamp() };',
    'const agent = pkg.createVoiceAgent({ prompt: "Handle a browser call.", providers: { telephony: { provider: "web-client-audio" }, stt, llm, tts } });',
    'const session = await agent.start({ call, channel: "web_audio", callHandle: ({ sessionId, call: runtimeCall }) => new pkg.WebClientAudioCallHandle({ socket, callId: runtimeCall.id, sessionId, heartbeatIntervalMs: 60_000, heartbeatTimeoutMs: 60_000 }) });',
    'socket.message(JSON.stringify({ type: "session.start", protocolVersion: 1, mode: "continuous", clientPlatform: "packed-smoke", audioFormat: pkg.PCM16_16K_MONO }));',
    'const ready = socket.sent.map((value) => JSON.parse(value)).find((value) => value.type === "session.ready");',
    "if (ready?.sessionId !== session.sessionId) throw new Error(`transport session mismatch: ${ready?.sessionId} !== ${session.sessionId}`);",
    "await opened;",
    'socket.message(JSON.stringify({ type: "session.end" }));',
    "const result = await session.run;",
    "if (result.turnsHandled !== 0) throw new Error(`unexpected transport turns: ${result.turnsHandled}`);",
    "await agent.stop();",
    'console.log("packed managed transport correlation ok");',
  ].join("\n");
  await execFileAsync("node", ["--input-type=module", "-e", managedTransportCheck], {
    cwd: projectDirectory,
  });

  const consumerSource = `
import {
  type Call,
  type CallId,
  createVoiceAgent,
  defineTool,
  type SessionId,
  type CallHandle,
  type WebClientAudioCallHandleOptions,
  type WebClientAudioSocket,
  type VoiceAgentCallHandleFactory,
  type VoiceEvent,
} from "voice-runtime";

declare const callHandle: CallHandle;
declare const call: Call;
declare const webSocket: WebClientAudioSocket;
const webHandleOptions: WebClientAudioCallHandleOptions = {
  socket: webSocket,
  callId: "web-call" as CallId,
  sessionId: "web-session" as SessionId,
};
void webHandleOptions;
const callHandleFactory: VoiceAgentCallHandleFactory = ({ sessionId, call: runtimeCall }) => {
  void sessionId;
  void runtimeCall;
  return callHandle;
};
const tool = defineTool<{ readonly date: string }, { readonly booked: boolean }>({
  id: "book_appointment",
  name: "book_appointment",
  description: "Books an appointment.",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  async execute(input) { return { booked: input.date.length > 0 }; },
});
const agent = createVoiceAgent({
  prompt: "Schedule an appointment.",
  tools: [tool],
  providers: {
    telephony: { provider: "web-client-audio" },
    stt: { provider: "deepgram", apiKey: "test" },
    llm: { provider: "openai", apiKey: "test", model: "gpt-4.1-mini" },
    tts: { provider: "cartesia", apiKey: "test", voiceId: "test" },
  },
});

async function check(): Promise<void> {
  const session = await agent.start({ callHandle: callHandleFactory, call, channel: "web_audio" });
  for await (const event of session.run) {
    const typedEvent: VoiceEvent = event;
    void typedEvent;
  }
  const result = await session.run;
  result.turnsHandled satisfies number;
}

void check;
`;
  const consumerPath = path.join(projectDirectory, "consumer.ts");
  await writeFile(consumerPath, consumerSource, "utf8");
  await execFileAsync(
    path.join(repositoryRoot, "node_modules", "typescript", "bin", "tsc"),
    [
      consumerPath,
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--lib",
      "ES2022,DOM",
    ],
    { cwd: projectDirectory },
  );

  const installedFiles = await readdir(
    path.join(projectDirectory, "node_modules", "voice-runtime"),
  );
  if (!installedFiles.includes("dist") || installedFiles.includes("src")) {
    throw new Error("external package contains an unexpected file layout");
  }
  const installedRoot = path.join(projectDirectory, "node_modules", "voice-runtime");
  for (const requiredFile of ["README.md", "LICENSE", "package.json"]) {
    await readFile(path.join(installedRoot, requiredFile));
  }
  const installedManifest = JSON.parse(
    await readFile(path.join(installedRoot, "package.json"), "utf8"),
  );
  for (const [name, version] of Object.entries(installedManifest.dependencies ?? {})) {
    if (typeof version === "string" && version.startsWith("workspace:")) {
      throw new Error(`published package contains unresolved workspace dependency: ${name}`);
    }
  }
  for (const mapName of ["index.js.map", "index.cjs.map"]) {
    const map = JSON.parse(await readFile(path.join(installedRoot, "dist", mapName), "utf8"));
    if (map.sources.some((source) => path.isAbsolute(source))) {
      throw new Error(`published source map contains an absolute local path: ${mapName}`);
    }
  }
  console.log(
    `check-public-package: ${packageManifest.name}@${packageManifest.version} installs and loads externally`,
  );
} finally {
  await rm(smokeDirectory, { recursive: true, force: true });
}
