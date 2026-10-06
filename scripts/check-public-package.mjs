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
const tarballArgumentIndex = process.argv.indexOf("--tarball");
const suppliedTarball =
  tarballArgumentIndex >= 0 ? process.argv[tarballArgumentIndex + 1] : undefined;
if (tarballArgumentIndex >= 0 && !suppliedTarball) {
  throw new Error("--tarball requires a path to an existing npm archive");
}
const smokeDirectory = await mkdtemp(path.join(tmpdir(), "voice-runtime-package-"));
const packageSource = suppliedTarball ? "supplied archive" : "locally packed checkout";

try {
  let tarball;
  if (suppliedTarball) {
    tarball = path.resolve(suppliedTarball);
    await readFile(tarball);
  } else {
    await execFileAsync(
      "npm",
      ["pack", "--pack-destination", smokeDirectory, "--json", "--ignore-scripts"],
      { cwd: packageDirectory },
    );
    const tarballName = `${packageManifest.name.replaceAll("/", "-")}-${packageManifest.version}.tgz`;
    tarball = path.join(smokeDirectory, tarballName);
  }
  const projectDirectory = path.join(smokeDirectory, "project");
  await mkdir(projectDirectory);
  await execFileAsync("npm", ["init", "-y"], { cwd: projectDirectory });
  await execFileAsync("npm", ["install", tarball, "--no-audit", "--no-fund", "--ignore-scripts"], {
    cwd: projectDirectory,
  });

  const esmCheck = [
    'const pkg = await import("voice-runtime");',
    'for (const name of ["createVoiceAgent", "createRuntime", "defineAgent", "runPostgresMigrations", "runPostgresMemoryMigrations", "toRuntimeSessionTrace"]) {',
    '  if (typeof pkg[name] !== "function") throw new Error(`missing ESM export: ${name}`);',
    "}",
    'if (pkg.PROVIDER_STABILITY?.webClientAudio !== "stable") throw new Error("missing provider maturity labels");',
    'if (pkg.PROVIDER_STABILITY_LEVELS?.join(",") !== "deferred,experimental,validated,stable") throw new Error("missing provider maturity levels");',
    'console.log("external ESM import ok");',
  ].join("\n");
  await execFileAsync("node", ["--input-type=module", "-e", esmCheck], {
    cwd: projectDirectory,
  });

  const commonJsCheck = [
    'const pkg = require("voice-runtime");',
    'for (const name of ["createVoiceAgent", "createRuntime", "defineAgent", "runPostgresMigrations", "runPostgresMemoryMigrations", "toRuntimeSessionTrace"]) {',
    '  if (typeof pkg[name] !== "function") throw new Error(`missing CJS export: ${name}`);',
    "}",
    'if (pkg.PROVIDER_STABILITY?.twilio !== "stable") throw new Error("missing CJS provider maturity labels");',
    'if (pkg.PROVIDER_STABILITY_LEVELS?.join(",") !== "deferred,experimental,validated,stable") throw new Error("missing CJS provider maturity levels");',
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
    'const web = new pkg.WebClientAudioCallHandle({ socket: webSocket, callId: "public-web-call", sessionId: "public-web-session", heartbeatIntervalMs: 60_000, heartbeatTimeoutMs: 120_000 });',
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
    'if (durable.join(",") !== "1,2,3,4,5,6,7,8") throw new Error(`unexpected durable migrations: ${durable}`);',
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
    "let managedSessionId;",
    "const callHandle = {",
    '  callId: "packed-call",',
    "  events: inbound,",
    "  async send() { return true; },",
    "  async clear() {},",
    "  async endInput(reason) {",
    '    if (reason !== "completed" || !managedSessionId) throw new Error("unexpected input end request");',
    '    inbound.push(pkg.createMediaEvent({ id: "packed-input-end", type: "media.stream.ended", sessionId: managedSessionId, sequence: 2, direction: "input", timestamp: pkg.nowTimestamp(), monotonicOffsetMs: 0, reason: "completed", durationMs: 0 }));',
    "    inbound.close();",
    "  },",
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
    'const session = await agent.start({ call, callHandle: async ({ sessionId }) => { if (!sessionId) throw new Error("missing managed session id"); managedSessionId = sessionId; return callHandle; }, channel: "simulated" });',
    'if (!(session.finalSession instanceof Promise) || typeof session.complete !== "function" || typeof session.stop !== "function") throw new Error("packed managed session lifecycle API is missing");',
    "const resultPromise = session.run.then((result) => result);",
    "await opened;",
    'inbound.push(pkg.createMediaEvent({ id: "packed-start", type: "media.stream.started", sessionId: session.sessionId, sequence: 1, direction: "input", timestamp: pkg.nowTimestamp(), monotonicOffsetMs: 0, format: pkg.PCM16_16K_MONO }));',
    "const terminal = await session.complete();",
    'if (terminal.status !== "completed" || terminal.terminalSource !== "normal_completion" || terminal.id !== session.sessionId) throw new Error("packed managed session did not complete normally");',
    "const result = await resultPromise;",
    'if (result.terminalReason !== "completed" || result.terminalSource !== "normal_completion") throw new Error("packed managed run did not complete normally");',
    "const finalSession = await session.finalSession;",
    'if (finalSession.status !== "completed" || finalSession.terminalSource !== "normal_completion") throw new Error("packed final session did not complete normally");',
    "await agent.stop();",
    'console.log("packed managed session completes normally");',
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
    'const session = await agent.start({ call, channel: "web_audio", callHandle: ({ sessionId, call: runtimeCall }) => new pkg.WebClientAudioCallHandle({ socket, callId: runtimeCall.id, sessionId, heartbeatIntervalMs: 60_000, heartbeatTimeoutMs: 120_000 }) });',
    "const resultPromise = session.run.then((result) => result);",
    'socket.message(JSON.stringify({ type: "session.start", protocolVersion: 1, mode: "continuous", clientPlatform: "packed-smoke", audioFormat: pkg.PCM16_16K_MONO }));',
    'const ready = socket.sent.map((value) => JSON.parse(value)).find((value) => value.type === "session.ready");',
    "if (ready?.sessionId !== session.sessionId) throw new Error(`transport session mismatch: ${ready?.sessionId} !== ${session.sessionId}`);",
    "await opened;",
    'socket.message(JSON.stringify({ type: "session.end" }));',
    'const result = await resultPromise.catch((error) => { if (error?.code !== "voice_runtime.remote_hangup") throw error; return null; });',
    'if (result !== null) throw new Error("an ended transport should reject as remote_hangup");',
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
  toRuntimeSessionTrace,
  type SessionId,
  type CallHandle,
  type SessionLease,
  type SessionLeaseStore,
  type SessionRecoveryCandidate,
  type ToolIdempotencyClaim,
  type ToolIdempotencyLease,
  type ToolIdempotencyRecord,
  type WebClientAudioCallHandleOptions,
  type WebClientAudioSocket,
  type VoiceAgentCallHandleFactory,
  type VoiceEvent,
  type ManagedVoiceAgentSession,
  type NodeMediaPlaneOptions,
  type RuntimeSessionTrace,
  type SessionMetricsRecorder,
  type StreamEndReason,
  type TerminalSession,
  type UpgradeAuthorization,
  type VoiceAgentProviders,
} from "voice-runtime";

declare const callHandle: CallHandle;
declare const call: Call;
declare const webSocket: WebClientAudioSocket;
declare const lease: SessionLease;
declare const leaseStore: SessionLeaseStore;
declare const recoveryCandidate: SessionRecoveryCandidate;
const leaseGenerationId: string = lease.generationId;
const candidateGenerationId: string = recoveryCandidate.generationId;
const renewedLease: Promise<SessionLease | null> = leaseStore.renew(
  lease.sessionId,
  lease.holder,
  lease.fence,
  1_000,
  lease.generationId,
);
const releasedLease: Promise<void> = leaseStore.release(
  lease.sessionId,
  lease.holder,
  lease.fence,
  lease.generationId,
);
const idempotencyLease: ToolIdempotencyLease = {
  sessionId: lease.sessionId,
  holder: lease.holder,
  fence: lease.fence,
  generationId: lease.generationId,
};
const idempotencyClaim: ToolIdempotencyClaim = {
  key: "public-consumer-key",
  lease: idempotencyLease,
  requestHash: "request-hash",
  owner: "owner",
  ttlMs: 1_000,
};
declare const idempotencyRecord: ToolIdempotencyRecord;
const claimedGenerationId: string | undefined = idempotencyRecord.claimedGenerationId;
void [
  leaseGenerationId,
  candidateGenerationId,
  renewedLease,
  releasedLease,
  idempotencyClaim,
  claimedGenerationId,
];
declare const managedSession: ManagedVoiceAgentSession;
const terminalSession: Promise<TerminalSession> = managedSession.finalSession;
const completedSession: Promise<TerminalSession> = managedSession.complete();
const stoppedSession: Promise<void> = managedSession.stop();
void terminalSession;
void completedSession;
void stoppedSession;
declare const trace: RuntimeSessionTrace;
const traceObserver: NonNullable<SessionMetricsRecorder["onSessionTrace"]> = (value) => {
  value.schemaVersion satisfies 1;
  value.privacy.classification satisfies "metadata_only";
};
declare const sessionEndEvent: Parameters<typeof toRuntimeSessionTrace>[0];
const projectedTrace: RuntimeSessionTrace = toRuntimeSessionTrace(sessionEndEvent);
void trace;
void traceObserver;
void projectedTrace;
const authorizationResult: UpgradeAuthorization<{ readonly callId: string }> = {
  ok: true,
  context: { callId: "web-call" },
};
void authorizationResult;
const mediaPlaneOptions: NodeMediaPlaneOptions<{ readonly callId: string }> = {
  port: 0,
  path: "/calls/:callId",
  onConnection() {},
  async authorizeUpgrade(_request, _url, params, signal) {
    signal.throwIfAborted();
    return { ok: true, context: { callId: params.callId ?? "unknown" } };
  },
  onUpgradeAbortedError(error: unknown, context: { readonly callId: string }) {
    void error;
    void context.callId;
  },
  async healthCheck(signal) {
    signal.throwIfAborted();
    return { ok: true };
  },
  onRequest(_request, _response, signal) {
    signal.throwIfAborted();
    return false;
  },
  authorizationTimeoutMs: 250,
  maxPendingAuthorizations: 64,
  webSocketCloseTimeoutMs: 5000,
};
void mediaPlaneOptions;
const halfClose: ((reason: StreamEndReason) => Promise<void>) | undefined = callHandle.endInput;
const remoteHangup: Promise<void> | undefined = callHandle.remoteHangup;
void halfClose;
void remoteHangup;
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
declare const providers: VoiceAgentProviders;
const agent = createVoiceAgent({ prompt: "Schedule an appointment.", tools: [tool], providers });

async function check(): Promise<void> {
  const session = await agent.start({ callHandle: callHandleFactory, call, channel: "web_audio" });
  const managed: ManagedVoiceAgentSession = session;
  const finalSession: Promise<TerminalSession> = managed.finalSession;
  const completed: Promise<TerminalSession> = managed.complete();
  const stopped: Promise<void> = managed.stop();
  void finalSession;
  void completed;
  void stopped;
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
  for (const requiredFile of [
    "README.md",
    "LICENSE",
    "package.json",
    "bin/voice-runtime.mjs",
    "skills/tvic/SKILL.md",
  ]) {
    await readFile(path.join(installedRoot, requiredFile));
  }
  const installedManifest = JSON.parse(
    await readFile(path.join(installedRoot, "package.json"), "utf8"),
  );
  if (installedManifest.bin?.["voice-runtime"] !== "./bin/voice-runtime.mjs") {
    throw new Error("published package is missing its voice-runtime CLI");
  }
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
  await execFileAsync(
    process.execPath,
    [
      path.join(installedRoot, "bin", "voice-runtime.mjs"),
      "skills",
      "install",
      "--yes",
      "--agent",
      "codex",
    ],
    { cwd: projectDirectory },
  );
  await readFile(path.join(projectDirectory, ".agents", "skills", "tvic", "SKILL.md"));
  await execFileAsync(
    path.join(projectDirectory, "node_modules", ".bin", "voice-runtime"),
    ["skills", "install", "--yes", "--agent", "claude"],
    { cwd: projectDirectory },
  );
  await readFile(path.join(projectDirectory, ".claude", "skills", "tvic", "SKILL.md"));
  console.log(
    `check-public-package: ${installedManifest.name}@${installedManifest.version} (${packageSource}) installs and loads externally`,
  );
} finally {
  await rm(smokeDirectory, { recursive: true, force: true });
}
