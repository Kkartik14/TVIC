import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { runMockCall } from "./mock-call.js";
import { buildStereoWav } from "./stereo-wav.js";

const outputPath = resolve(process.argv[2] ?? "output/mock-call.wav");
const recording = await runMockCall();
const wav = buildStereoWav(recording.frames);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, wav);

console.log(`Wrote ${outputPath}`);
console.log(`Turns: ${recording.turnsHandled}`);
console.log(`Audio tap: ${recording.summary.enabled ? "enabled" : "disabled"}`);
console.log(`Dropped audio frames: ${recording.summary.droppedFrames}`);
