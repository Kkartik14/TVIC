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
    'for (const name of ["createVoiceAgent", "createRuntime", "defineAgent", "resolveTtsCallSelection", "resolveSttCallSelection", "loadCartesiaCapabilitySnapshot", "loadElevenLabsCapabilitySnapshot", "runPostgresMigrations", "runPostgresMemoryMigrations", "toRuntimeSessionTrace"]) {',
    '  if (typeof pkg[name] !== "function") throw new Error(`missing ESM export: ${name}`);',
    "}",
    'if (pkg.MAX_USAGE_OBSERVATION_SAMPLES !== 32) throw new Error("missing usage observation sample limit");',
    'if (pkg.MAX_STT_LANGUAGE_HINTS !== 16) throw new Error("missing STT language hint limit");',
    'if (pkg.MAX_SESSION_USAGE_ENTRIES !== 128 || pkg.MAX_SESSION_USAGE_METRICS_PER_ENTRY !== 32 || pkg.MAX_SESSION_USAGE_IDENTIFIER_LENGTH !== 128) throw new Error("missing session usage bounds");',
    'if (pkg.PROVIDER_STABILITY?.webClientAudio !== "stable") throw new Error("missing provider maturity labels");',
    'if (pkg.PROVIDER_STABILITY_LEVELS?.join(",") !== "deferred,experimental,validated,stable") throw new Error("missing provider maturity levels");',
    'if (pkg.MAX_TTS_TEXT_CONTROLS !== 32 || pkg.MAX_TTS_TEXT_CONTROL_PAUSE_MS !== 5000) throw new Error("missing public TTS text control bounds");',
    'if (pkg.PROVIDER_CAPABILITY_FEATURES?.ttsVoiceAvailable !== "tts.voice.available" || "ttsVoiceCategory" in pkg.PROVIDER_CAPABILITY_FEATURES) throw new Error("invalid provider-neutral capability features");',
    'if (pkg.ELEVENLABS_CAPABILITY_FEATURES?.ttsVoiceCategory !== "tts.voice.category") throw new Error("missing ElevenLabs capability features");',
    'console.log("external ESM import ok");',
  ].join("\n");
  await execFileAsync("node", ["--input-type=module", "-e", esmCheck], {
    cwd: projectDirectory,
  });

  const commonJsCheck = [
    'const pkg = require("voice-runtime");',
    'for (const name of ["createVoiceAgent", "createRuntime", "defineAgent", "resolveTtsCallSelection", "resolveSttCallSelection", "loadCartesiaCapabilitySnapshot", "loadElevenLabsCapabilitySnapshot", "runPostgresMigrations", "runPostgresMemoryMigrations", "toRuntimeSessionTrace"]) {',
    '  if (typeof pkg[name] !== "function") throw new Error(`missing CJS export: ${name}`);',
    "}",
    'if (pkg.MAX_USAGE_OBSERVATION_SAMPLES !== 32) throw new Error("missing usage observation sample limit");',
    'if (pkg.MAX_STT_LANGUAGE_HINTS !== 16) throw new Error("missing CJS STT language hint limit");',
    'if (pkg.MAX_SESSION_USAGE_ENTRIES !== 128 || pkg.MAX_SESSION_USAGE_METRICS_PER_ENTRY !== 32 || pkg.MAX_SESSION_USAGE_IDENTIFIER_LENGTH !== 128) throw new Error("missing CJS session usage bounds");',
    'if (pkg.PROVIDER_STABILITY?.twilio !== "stable") throw new Error("missing CJS provider maturity labels");',
    'if (pkg.PROVIDER_STABILITY_LEVELS?.join(",") !== "deferred,experimental,validated,stable") throw new Error("missing CJS provider maturity levels");',
    'if (pkg.MAX_TTS_TEXT_CONTROLS !== 32 || pkg.MAX_TTS_TEXT_CONTROL_PAUSE_MS !== 5000) throw new Error("missing CJS TTS text control bounds");',
    'if (pkg.PROVIDER_CAPABILITY_FEATURES?.ttsVoiceAvailable !== "tts.voice.available" || "ttsVoiceCategory" in pkg.PROVIDER_CAPABILITY_FEATURES) throw new Error("invalid CJS provider-neutral capability features");',
    'if (pkg.ELEVENLABS_CAPABILITY_FEATURES?.ttsVoiceCategory !== "tts.voice.category") throw new Error("missing CJS ElevenLabs capability features");',
    'console.log("external CJS require ok");',
  ].join("\n");
  await execFileAsync("node", ["-e", commonJsCheck], { cwd: projectDirectory });

  const consumerSource = `
import {
  PCM16_16K_MONO,
  type Call,
  type CallId,
  createVoiceAgent,
  defineTool,
  loadCartesiaCapabilitySnapshot,
  loadElevenLabsCapabilitySnapshot,
  toRuntimeSessionTrace,
  MAX_USAGE_OBSERVATION_SAMPLES,
  MAX_STT_LANGUAGE_HINTS,
  MAX_SESSION_USAGE_ENTRIES,
  MAX_SESSION_USAGE_METRICS_PER_ENTRY,
  MAX_SESSION_USAGE_IDENTIFIER_LENGTH,
  type SessionId,
  type TurnId,
  type SessionUsageEntry,
  type SessionUsageSummary,
  type UsageMetric,
  type UsageModelOrigin,
  type UsageModelSource,
  type UsageNotReportedReason,
  type UsageUnit,
  type ProviderCatalogEntry,
  type LoadCartesiaCapabilitySnapshotOptions,
  type LoadElevenLabsCapabilitySnapshotOptions,
  type ProviderCapabilitySnapshotLoader,
  type ProviderCapabilities,
  type ProviderCapabilityFact,
  type ProviderCapabilityQuery,
  type ProviderCapabilitySnapshot,
  type ProviderTtsTextControlCapability,
  type ProviderTtsVoiceCapabilityRequirement,
  type ProviderUsageField,
  type ProviderUsageObservation,
  type ProviderUsageOperation,
  type SttAudioWriteUsageOperation,
  type TtsUsageAccounting,
  type TtsSessionOpenRequest,
  type LlmUsageReport,
  type TtsUsageReporter,
  type SttUsageReporter,
  type SttLanguagePolicy,
  type SttOpenRequest,
  type SttStream,
  type SttCallSelection,
  type SttCallSelectionInput,
  type TtsProviderSelection,
  type TtsCallSelection,
  type TtsCallSelectionInput,
  type TtsFailoverRequestVariant,
  type TtsSynthesisRequest,
  type VoiceAgentRunOptions,
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
  type ManagedVoiceAgentFinalSession,
  type NodeMediaPlaneOptions,
  type RuntimeSessionTrace,
  type SessionMetricsRecorder,
  type StreamEndReason,
  type TerminalSession,
  type UpgradeAuthorization,
  type VoiceAgentProviders,
  type TtsTextControl,
  type TtsTextControlKind,
  type TurnTakingProfile,
} from "voice-runtime";

declare const callHandle: CallHandle;
declare const call: Call;
declare const webSocket: WebClientAudioSocket;
declare const sessionId: SessionId;
declare const turnId: TurnId;
const sttLanguagePolicy: SttLanguagePolicy = {
  mode: "hints",
  languages: ["en-US", "hi-IN"],
  strictness: "best_effort",
};
const sttLanguageHintLimit: 16 = MAX_STT_LANGUAGE_HINTS;
const phaseOneRunOptions: VoiceAgentRunOptions = {
  callHandle,
  ttsModel: "model-a",
  ttsVoice: "voice-a",
  ttsLanguage: "en-US",
  ttsSpeed: 1,
  sttLanguagePolicy,
  sttVocabulary: ["TVIC"],
  sttConversationContext: true,
  includeToolNamesInSttVocabulary: false,
};
const sttOpenRequest: SttOpenRequest = {
  sessionId,
  format: PCM16_16K_MONO,
  languagePolicy: sttLanguagePolicy,
  vocabulary: ["TVIC"],
  interimResults: true,
};
const ttsSelection: TtsProviderSelection = {
  model: "model-a",
  voice: "voice-a",
  language: "en-US",
  speed: 1,
};
declare const resolvedSttSelection: SttCallSelection;
declare const sttSelectionInput: SttCallSelectionInput;
declare const resolvedTtsSelection: TtsCallSelection;
declare const ttsSelectionInput: TtsCallSelectionInput;
declare const fallbackVariant: TtsFailoverRequestVariant;
void [
  resolvedSttSelection,
  sttSelectionInput,
  resolvedTtsSelection,
  ttsSelectionInput,
  fallbackVariant,
];
const ttsSessionRequest: TtsSessionOpenRequest = {
  sessionId,
  turnId,
  format: PCM16_16K_MONO,
  ...ttsSelection,
};
const ttsSynthesisRequest: TtsSynthesisRequest = {
  ...ttsSessionRequest,
  text: "Hello.",
  stream: true,
};
const updateAgentContext: SttStream["updateAgentContext"] = async () => {};
void [sttLanguageHintLimit, phaseOneRunOptions, sttOpenRequest, ttsSessionRequest, ttsSynthesisRequest, updateAgentContext];
const consumerCatalogEntry: ProviderCatalogEntry = {
  verifiedAt: "2026-01-01",
  source: "https://example.test/catalog",
  defaultModel: "model-a",
  models: ["model-a"],
};

const cartesiaSnapshotLoader: typeof loadCartesiaCapabilitySnapshot = loadCartesiaCapabilitySnapshot;
const elevenLabsSnapshotLoader: typeof loadElevenLabsCapabilitySnapshot = loadElevenLabsCapabilitySnapshot;
const cartesiaSnapshotOptions: LoadCartesiaCapabilitySnapshotOptions = {
  apiKey: "test",
  modelIds: ["sonic-3.6"],
  voiceIds: ["voice-id"],
  validUntil: "2026-10-26T00:00:00.000Z",
  timeoutMs: 30_000,
};
const elevenLabsSnapshotOptions: LoadElevenLabsCapabilitySnapshotOptions = {
  apiKey: "test",
  modelIds: ["eleven_flash_v2_5"],
  validUntil: "2026-10-26T00:00:00.000Z",
  timeoutMs: 30_000,
};
void [cartesiaSnapshotLoader, elevenLabsSnapshotLoader, cartesiaSnapshotOptions, elevenLabsSnapshotOptions];
void consumerCatalogEntry;
const capabilityFact: ProviderCapabilityFact = {
  feature: "tts.normalization.forced",
  scope: "account",
  status: "supported",
};
const capabilitySnapshot: ProviderCapabilitySnapshot = {
  provider: "elevenlabs",
  source: "https://example.test/capabilities",
  fetchedAt: "2026-10-25T00:00:00.000Z",
  validUntil: "2026-10-26T00:00:00.000Z",
  facts: [capabilityFact],
};
const snapshotLoaderContract: ProviderCapabilitySnapshotLoader = async (selection) => {
  const voiceSelection = selection.providerCapabilitySnapshotVoices?.[0];
  const modelSource: "selected" | "mapped" | undefined = voiceSelection?.modelSource;
  const side: "primary" | "fallback" | undefined = voiceSelection?.side;
  const snapshotProviders: readonly string[] | undefined =
    selection.providerCapabilitySnapshotProviders;
  void [modelSource, side, snapshotProviders];
  return [capabilitySnapshot];
};
const failoverVariant: TtsFailoverRequestVariant = {
  when: { model: "eleven_v3", voice: "voice-a" },
  fallback: { model: "eleven_v3", voice: "voice-b" },
};
void [snapshotLoaderContract, failoverVariant];
declare const ttsOpenRequest: TtsSessionOpenRequest;
const ttsCapabilitySnapshots: readonly ProviderCapabilitySnapshot[] =
  ttsOpenRequest.providerCapabilitySnapshots ?? [];
void ttsCapabilitySnapshots;
const capabilityQuery: ProviderCapabilityQuery = {
  provider: "elevenlabs",
  feature: "tts.normalization.forced",
  scope: "account",
};
const modelCapabilityQuery: ProviderCapabilityQuery = {
  provider: "elevenlabs",
  feature: "tts.model.canUseSpeakerBoost",
  scope: "model",
  model: "eleven_flash_v2_5",
  expectedBooleanValue: true,
};
const snapshotScopedCapabilities: ProviderCapabilities = {
  streaming: { input: true, output: true, native: true },
  cancellation: { request: true, output: true, buffer: true, truncation: true },
  transports: ["websocket"],
  modelSnapshotProviders: ["elevenlabs"],
};
const voiceCapabilityRequirement: ProviderTtsVoiceCapabilityRequirement = {
  provider: "cartesia",
  feature: "tts.voice.isPro",
  expectedBooleanValue: false,
  voiceSource: "mapped",
};
const languageCapabilityRequirement: ProviderTtsVoiceCapabilityRequirement = {
  provider: "elevenlabs",
  feature: "tts.voice.verifiedLocales",
  modelSource: "selected",
  configuredLanguageMustBeVerified: true,
};
const textControlCapability: ProviderTtsTextControlCapability = {
  model: "sonic-3.6",
  controls: ["spell", "pause"],
};
const textControls: readonly TtsTextControl[] = [
  { type: "spell", match: "TVIC" },
  { type: "pause", match: "next", durationMs: 250 },
];
const textControlKind: TtsTextControlKind = textControls[0]!.type;
const turnTakingProfile: TurnTakingProfile = "balanced";
void [
  capabilitySnapshot,
  capabilityQuery,
  modelCapabilityQuery,
  snapshotScopedCapabilities,
  voiceCapabilityRequirement,
  languageCapabilityRequirement,
  textControlCapability,
  textControlKind,
  turnTakingProfile,
];
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
const finalSession: Promise<ManagedVoiceAgentFinalSession> = managedSession.finalSession;
const terminalSession: Promise<TerminalSession> = finalSession;
const completedSession: Promise<TerminalSession> = managedSession.complete();
const stoppedSession: Promise<void> = managedSession.stop();
void terminalSession;
void completedSession;
void stoppedSession;
declare const managedFinalSession: ManagedVoiceAgentFinalSession;
const managedSessionUsage: SessionUsageSummary = managedFinalSession.usage;
const truncatedSessionUsage: SessionUsageSummary = { entries: [], truncated: true };
const usageBounds: readonly [128, 32, 128] = [
  MAX_SESSION_USAGE_ENTRIES,
  MAX_SESSION_USAGE_METRICS_PER_ENTRY,
  MAX_SESSION_USAGE_IDENTIFIER_LENGTH,
];
const usageEntry: SessionUsageEntry = managedSessionUsage.entries[0]!;
const providerUsageField: ProviderUsageField = { status: "reported", value: 12 };
const usageObservation: ProviderUsageObservation = {
  field: "durationMs",
  status: "not_reported",
  reason: "absent",
  unit: "milliseconds",
  aggregation: "observations",
};
const usageUnit: UsageUnit = usageObservation.unit;
const missingReason: UsageNotReportedReason = "interrupted";
const modelSource: UsageModelSource = "provider_reported";
const modelOrigin: UsageModelOrigin = "not_reported";
const usageSampleLimit: 32 = MAX_USAGE_OBSERVATION_SAMPLES;
const usageMetric: UsageMetric = {
  status: "partial",
  source: "provider",
  unit: "tokens",
  value: 12,
  observedOperations: 1,
  notReported: [{ reason: "interrupted", operations: 1 }],
};
const llmUsageReport: LlmUsageReport = {
  inputTokens: { status: "reported", value: 12 },
  outputTokens: { status: "not_reported", reason: "absent" },
  cachedTokens: { status: "not_reported", reason: "invalid" },
};
const ttsUsageAccounting: TtsUsageAccounting = {
  reportsTextCharacters: true,
  usesRequestModelForUsage: true,
};
const ttsUsageReporter: TtsUsageReporter = {
  report(_observation) {},
  beginOperation(input): ProviderUsageOperation {
    const origin: UsageModelOrigin = input.modelSource ?? modelOrigin;
    void origin;
    return { report() {}, notReported() {}, finish() {} };
  },
  reportTextCharacters(codePoints) {
    const textCodePoints: number = codePoints;
    void textCodePoints;
  },
};
const sttUsageReporter: SttUsageReporter = {
  report(_observation) {},
  beginOperation(): ProviderUsageOperation {
    return { report() {}, notReported() {}, finish() {} };
  },
  beginAudioWrite({ byteLength, format }): SttAudioWriteUsageOperation {
    const audioBytes: number = byteLength;
    const encoding: string = format.encoding;
    void [audioBytes, encoding];
    return { succeeded() {}, failed() {} };
  },
};
void [
  managedSessionUsage,
  truncatedSessionUsage,
  usageBounds,
  usageEntry,
  providerUsageField,
  usageObservation,
  modelOrigin,
  usageUnit,
  missingReason,
  modelSource,
  usageSampleLimit,
  usageMetric,
  llmUsageReport,
  ttsUsageAccounting,
  ttsUsageReporter,
  sttUsageReporter,
];
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
  const session = await agent.start({
    callHandle: callHandleFactory,
    call,
    channel: "web_audio",
    turnProfile: turnTakingProfile,
    ttsVoice: "account-voice-id",
    ttsTextControls: textControls,
  });
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
  const readme = await readFile(path.join(packageDirectory, "README.md"), "utf8");
  const quickStart = readme.match(/## Prompt-first agent[\s\S]*?```ts\n([\s\S]*?)\n```/u)?.[1];
  if (!quickStart) {
    throw new Error("voice-runtime README is missing its Prompt-first agent TypeScript example");
  }
  const readmeQuickStartPath = path.join(projectDirectory, "readme-quickstart.mts");
  await writeFile(
    readmeQuickStartPath,
    `declare const process: { readonly env: Record<string, string | undefined> };\n${quickStart}\n`,
    "utf8",
  );
  await execFileAsync(
    path.join(repositoryRoot, "node_modules", "typescript", "bin", "tsc"),
    [
      consumerPath,
      readmeQuickStartPath,
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
