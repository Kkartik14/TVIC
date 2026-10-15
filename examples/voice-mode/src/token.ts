import { createAppUserToken } from "./security.js";
import { configuredSecret } from "./config.js";
import { loadLocalEnv } from "./env.js";

loadLocalEnv();

const userId = process.argv[2];
if (!userId) {
  console.error("Usage: pnpm --filter @tvic/example-voice-mode token -- <user-id>");
  process.exitCode = 1;
} else {
  try {
    console.log(createAppUserToken(userId, configuredSecret("VOICE_AUTH_SECRET")));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "VOICE_AUTH_SECRET is required");
    process.exitCode = 1;
  }
}
