import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFilePromise = promisify(execFile);
const execFileAsync = (file, args, options = {}) =>
  execFilePromise(file, args, { timeout: 120_000, ...options });
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

  const runtimeCheckPath = path.join(projectDirectory, "check-public-package-runtime.cjs");
  await writeFile(
    runtimeCheckPath,
    await readFile(
      path.join(repositoryRoot, "scripts", "check-public-package-runtime.cjs"),
      "utf8",
    ),
    "utf8",
  );
  for (const moduleMode of ["esm", "cjs"]) {
    const result = await execFileAsync(process.execPath, [runtimeCheckPath], {
      cwd: projectDirectory,
      env: { ...process.env, TVIC_PACKAGE_MODULE: moduleMode },
    });
    process.stdout.write(result.stdout);
  }
  if (process.env.TVIC_RUN_INTEGRATION === "1") {
    const durableResult = await execFileAsync(
      process.execPath,
      [
        path.join(repositoryRoot, "scripts", "check-public-durable-artifact.mjs"),
        "--tarball",
        tarball,
      ],
      { cwd: projectDirectory, env: process.env },
    );
    process.stdout.write(durableResult.stdout);
  }
  console.log(
    `check-public-package: ${installedManifest.name}@${installedManifest.version} (${packageSource}) installs and loads externally`,
  );
} finally {
  await rm(smokeDirectory, { recursive: true, force: true });
}
