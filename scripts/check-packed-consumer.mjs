import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const tarballIndex = process.argv.indexOf("--tarball");
const tarballArgument = tarballIndex >= 0 ? process.argv[tarballIndex + 1] : undefined;
if (!tarballArgument)
  throw new Error("Usage: node scripts/check-packed-consumer.mjs --tarball path.tgz");
const tarball = path.resolve(tarballArgument);
await readFile(tarball);

const projectDirectory = await mkdtemp(path.join(tmpdir(), "voice-runtime-consumer-"));
try {
  await execFileAsync("npm", ["init", "-y"], { cwd: projectDirectory });
  await execFileAsync(
    "npm",
    ["install", tarball, "typescript@5.7.2", "--no-audit", "--no-fund", "--ignore-scripts"],
    { cwd: projectDirectory },
  );

  await execFileAsync(
    "node",
    [
      "--input-type=module",
      "-e",
      [
        'const pkg = await import("voice-runtime");',
        'for (const name of ["createVoiceAgent", "createRuntime", "defineAgent"]) {',
        '  if (typeof pkg[name] !== "function") throw new Error(`missing ESM export: ${name}`);',
        "}",
        'console.log("packed ESM consumer ok");',
      ].join("\n"),
    ],
    { cwd: projectDirectory },
  );
  await execFileAsync(
    "node",
    [
      "-e",
      [
        'const pkg = require("voice-runtime");',
        'for (const name of ["createVoiceAgent", "createRuntime", "defineAgent"]) {',
        '  if (typeof pkg[name] !== "function") throw new Error(`missing CJS export: ${name}`);',
        "}",
        'console.log("packed CJS consumer ok");',
      ].join("\n"),
    ],
    { cwd: projectDirectory },
  );

  const source = [
    'import { createVoiceAgent, type Call, type CallHandle, type VoiceAgentCallHandleFactory } from "voice-runtime";',
    "declare const call: Call;",
    "declare const callHandle: CallHandle;",
    "const factory: VoiceAgentCallHandleFactory = ({ call: runtimeCall }) => { void runtimeCall; return callHandle; };",
    'const agent = createVoiceAgent({ prompt: "packed consumer", providers: { telephony: { provider: "web-client-audio" }, stt: { provider: "deepgram", apiKey: "test" }, llm: { provider: "openai", apiKey: "test" }, tts: { provider: "cartesia", apiKey: "test", voiceId: "test" } } });',
    'void agent.start({ call, callHandle: factory, channel: "web_audio" });',
  ].join("\n");
  const consumerPath = path.join(projectDirectory, "consumer.mts");
  await writeFile(consumerPath, source, "utf8");
  await execFileAsync(
    path.join(projectDirectory, "node_modules", ".bin", "tsc"),
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

  const installedRoot = path.join(projectDirectory, "node_modules", "voice-runtime");
  const installedFiles = await readdir(installedRoot);
  if (!installedFiles.includes("dist") || installedFiles.includes("src")) {
    throw new Error("packed consumer contains an unexpected source layout");
  }
  for (const requiredFile of [
    "dist/index.d.ts",
    "dist/index.cjs",
    "README.md",
    "LICENSE",
    "bin/voice-runtime.mjs",
    "skills/tvic/SKILL.md",
  ]) {
    await readFile(path.join(installedRoot, requiredFile));
  }
  const manifest = JSON.parse(await readFile(path.join(installedRoot, "package.json"), "utf8"));
  for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
    if (typeof version === "string" && version.startsWith("workspace:")) {
      throw new Error(`packed consumer contains unresolved workspace dependency: ${name}`);
    }
  }
  console.log(
    `check-packed-consumer: ${manifest.name}@${manifest.version} passed on Node ${process.versions.node}`,
  );
} finally {
  await rm(projectDirectory, { recursive: true, force: true });
}
