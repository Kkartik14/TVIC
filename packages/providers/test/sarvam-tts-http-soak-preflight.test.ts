import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const soakScript = fileURLToPath(
  new URL("../../../scripts/sarvam-tts-http-soak.ts", import.meta.url),
);
const repositoryRoot = resolve(dirname(soakScript), "..");

describe("Sarvam HTTP soak preflight", () => {
  it("rejects an unsupported model before creating output or starting jobs", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "sarvam-http-soak-preflight-"));
    const outputRoot = join(temporaryRoot, "output");
    try {
      const result = spawnSync(process.execPath, ["--import", "tsx", soakScript], {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          SARVAM_API_KEY: "local-preflight-test-key",
          SARVAM_TTS_MODEL: "unsupported-model",
          SARVAM_TTS_HTTP_SOAK_OUTPUT_DIR: outputRoot,
          SARVAM_TTS_HTTP_SOAK_TRANSPORTS: "rest",
          SARVAM_TTS_HTTP_SOAK_SAMPLES: "1",
          SARVAM_TTS_HTTP_SOAK_CONCURRENCY: "1",
          SARVAM_TTS_HTTP_SOAK_START_INTERVAL_MS: "1",
          SARVAM_TTS_HTTP_SOAK_RETRIES: "0",
        },
      });

      expect(result.status).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        "unsupported Sarvam TTS model: unsupported-model",
      );
      expect(existsSync(outputRoot)).toBe(false);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
