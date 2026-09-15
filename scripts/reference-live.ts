import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { readPcm16Wav } from "../examples/stt-only/src/wav.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const packageTarball = requiredEnv("PACKAGE_TARBALL");
  await readFile(packageTarball);
  await execFileAsync(
    process.execPath,
    [path.join(repositoryRoot, "scripts/check-packed-consumer.mjs"), "--tarball", packageTarball],
    { cwd: repositoryRoot },
  );

  const fixture = await materializeFixture();
  try {
    const wav = await readPcm16Wav(fixture.path);
    if (
      wav.format.encoding !== "pcm_s16le" ||
      wav.format.sampleRateHz !== 16_000 ||
      wav.format.channels !== 1
    ) {
      throw new Error("reference WAV must be mono 16-bit PCM at 16 kHz");
    }
    await runPackagedReference(packageTarball, fixture.path);
  } finally {
    if (fixture.temporary) {
      await rm(path.dirname(fixture.path), { recursive: true, force: true });
    }
  }
}

async function runPackagedReference(packageTarball: string, fixturePath: string): Promise<void> {
  const projectDirectory = await mkdtemp(path.join(tmpdir(), "voice-runtime-live-consumer-"));
  try {
    await execFileAsync("npm", ["init", "-y"], { cwd: projectDirectory });
    await execFileAsync(
      "npm",
      ["install", packageTarball, "--no-audit", "--no-fund", "--ignore-scripts"],
      { cwd: projectDirectory },
    );
    const runnerPath = path.join(projectDirectory, "reference-runner.mjs");
    await writeFile(runnerPath, PACKAGED_REFERENCE_RUNNER, "utf8");
    const result = await execFileAsync(process.execPath, [runnerPath, fixturePath], {
      cwd: projectDirectory,
      env: process.env,
      maxBuffer: 4 * 1024 * 1024,
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  } finally {
    await rm(projectDirectory, { recursive: true, force: true });
  }
}

async function materializeFixture(): Promise<{
  readonly path: string;
  readonly temporary: boolean;
}> {
  const existing = process.env.REFERENCE_WAV_PATH;
  if (existing) {
    await readFile(existing);
    return { path: existing, temporary: false };
  }
  const encoded = requiredEnv("REFERENCE_WAV_B64");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.byteLength === 0 || bytes.byteLength > 4 * 1024 * 1024) {
    throw new Error("REFERENCE_WAV_B64 must contain a non-empty WAV up to 4 MiB");
  }
  if (
    bytes.subarray(0, 4).toString("ascii") !== "RIFF" ||
    bytes.subarray(8, 12).toString("ascii") !== "WAVE"
  ) {
    throw new Error("REFERENCE_WAV_B64 must contain a RIFF/WAVE fixture");
  }
  const directory = await mkdtemp(path.join(tmpdir(), "tvic-reference-live-"));
  const fixture = path.join(directory, "reference.wav");
  await writeFile(fixture, bytes);
  return { path: fixture, temporary: true };
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required reference env var ${name}`);
  return value;
}

const PACKAGED_REFERENCE_RUNNER = String.raw`import { readFile } from "node:fs/promises";
import {
  PCM16_16K_MONO,
  WebClientAudioCallHandle,
  createVoiceAgent,
  splitPcm16leFrames,
} from "voice-runtime";

class ReferenceSocket {
  readyState = 1;
  ready = false;
  interruptSent = false;
  outputAudioBytes = 0;
  outputClears = 0;
  #handlers = new Map();

  on(event, handler) {
    const handlers = this.#handlers.get(event) ?? new Set();
    handlers.add(handler);
    this.#handlers.set(event, handlers);
    return this;
  }

  send(data) {
    if (Buffer.isBuffer(data)) {
      this.outputAudioBytes += Math.max(0, data.byteLength - 12);
      if (!this.interruptSent) {
        this.interruptSent = true;
        queueMicrotask(() =>
          this.message(JSON.stringify({ type: "client.interrupt" }), false),
        );
      }
      return;
    }
    const message = JSON.parse(String(data));
    if (message.type === "session.ready") this.ready = true;
    if (message.type === "output.clear") this.outputClears += 1;
    if (message.type === "output.commit") {
      queueMicrotask(() =>
        this.message(JSON.stringify({ type: "output.playout_ack", commitId: message.commitId }), false),
      );
    }
  }

  close(code = 1000, reason = "") {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", code, Buffer.from(reason));
  }

  message(data, isBinary = false) {
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    this.emit("message", payload, isBinary);
  }

  emit(event, ...args) {
    for (const handler of this.#handlers.get(event) ?? []) handler(...args);
  }
}

const fixturePath = process.argv[2];
if (!fixturePath) throw new Error("reference WAV path is required");
const wav = parsePcm16Wav(new Uint8Array(await readFile(fixturePath)));
const socket = new ReferenceSocket();
const agent = createVoiceAgent({
  id: "release-reference-agent",
  prompt: "Reply in one concise sentence to the caller.",
  providers: {
    telephony: { provider: "web-client-audio" },
    stt: {
      provider: "deepgram",
      apiKey: requiredEnv("DEEPGRAM_API_KEY"),
      model: process.env.STT_MODEL ?? "nova-3",
    },
    llm: {
      provider: "openai",
      apiKey: requiredEnv("OPENAI_API_KEY"),
      model: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
      ...(process.env.OPENAI_RESPONSES_URL
        ? { url: process.env.OPENAI_RESPONSES_URL }
        : {}),
    },
    tts: {
      provider: "cartesia",
      apiKey: requiredEnv("CARTESIA_API_KEY"),
      voiceId: requiredEnv("CARTESIA_VOICE_ID"),
      model: process.env.CARTESIA_MODEL ?? "sonic-3",
    },
  },
  audio: { input: PCM16_16K_MONO, output: PCM16_16K_MONO },
  interruptionPolicy: { mode: "graceful", minSpeechMs: 0, trimOutputOnInterrupt: true },
});

const timestamp = new Date().toISOString();
const call = {
  id: "release-reference-call",
  provider: "web-client-audio",
  direction: "inbound",
  from: "reference-fixture",
  to: "reference-agent",
  status: "connected",
  mediaTransport: { kind: "websocket", format: PCM16_16K_MONO },
  createdAt: timestamp,
  startedAt: timestamp,
};
const session = await agent.start({
  call,
  channel: "web_audio",
  callHandle: ({ sessionId }) =>
    new WebClientAudioCallHandle({
      socket,
      callId: call.id,
      sessionId,
      heartbeatIntervalMs: 60_000,
      heartbeatTimeoutMs: 60_000,
      maxSessionDurationMs: 120_000,
      expectedMode: "push_to_talk",
    }),
});

const events = [];
let runError;
const eventDrain = (async () => {
  try {
    for await (const event of session.run) events.push(event);
  } catch (error) {
    runError = error;
  }
})();

socket.message(
  JSON.stringify({
    type: "session.start",
    protocolVersion: 1,
    mode: "push_to_talk",
    clientPlatform: "release-reference",
    audioFormat: PCM16_16K_MONO,
  }),
);
await waitFor("Web Client Audio session.ready", () => socket.ready);

let sequence = 0;
for (const frame of splitPcm16leFrames(wav.bytes, wav.format, 20)) {
  sequence += 1;
  socket.message(audioFrame(frame, sequence), true);
}
socket.message(JSON.stringify({ type: "turn.end" }));

await waitFor(
  "final transcript",
  () => events.some((event) => event.kind === "transcript_delta" && event.isFinal && event.text.trim()),
);
await waitFor("incremental audio output", () => socket.outputAudioBytes > 0);
await waitFor("turn completion", () => events.some((event) => event.kind === "turn_completed"));

if (socket.interruptSent && socket.outputClears === 0) {
  const interrupted = events.some(
    (event) => event.kind === "turn_completed" && event.status === "cancelled",
  );
  if (!interrupted) throw new Error("reference interrupt did not cancel or clear output");
}

socket.message(JSON.stringify({ type: "session.end" }));
await eventDrain;
if (runError && runError.code !== "voice_runtime.remote_hangup") throw runError;
if (socket.outputAudioBytes === 0) throw new Error("reference chain produced no audio");
if (!events.some((event) => event.kind === "call_ended")) {
  throw new Error("reference chain did not produce a terminal call event");
}
await agent.stop();
console.log(
  "reference live chain passed through packed voice-runtime: " +
    "final transcript, streamed audio, interruption boundary, and clean shutdown",
);

function audioFrame(payload, sequence) {
  const frame = Buffer.alloc(12 + payload.byteLength);
  frame.writeUInt8(1, 0);
  frame.writeUInt8(0, 1);
  frame.writeUInt32LE(sequence, 2);
  frame.writeUInt32LE((sequence - 1) * 20, 6);
  frame.writeUInt16LE(0, 10);
  Buffer.from(payload).copy(frame, 12);
  return frame;
}

function parsePcm16Wav(bytes) {
  if (bytes.byteLength < 12 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") {
    throw new Error("reference fixture must be RIFF/WAVE");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let format;
  let audio;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const type = ascii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + size;
    if (end > bytes.byteLength) throw new Error("reference fixture has a truncated chunk");
    if (type === "fmt ") {
      if (size < 16) throw new Error("reference fixture has an incomplete fmt chunk");
      const chunk = new DataView(bytes.buffer, bytes.byteOffset + start, size);
      if (chunk.getUint16(0, true) !== 1 || chunk.getUint16(2, true) !== 1 || chunk.getUint16(14, true) !== 16) {
        throw new Error("reference fixture must be mono 16-bit PCM");
      }
      format = { encoding: "pcm_s16le", sampleRateHz: chunk.getUint32(4, true), channels: 1 };
    }
    if (type === "data") audio = bytes.slice(start, end);
    offset = end + (size % 2);
  }
  if (!format || !audio || audio.byteLength % 2 !== 0) {
    throw new Error("reference fixture is missing valid PCM data");
  }
  return { format, bytes: audio };
}

function ascii(bytes, offset, length) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("missing required reference env var " + name);
  return value;
}

async function waitFor(label, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for " + label);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
`;
