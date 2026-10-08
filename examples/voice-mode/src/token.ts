import { createAppUserToken } from "./security.js";
import { isProductionEnv, loadLocalEnv } from "./env.js";

loadLocalEnv();

const userId = process.argv[2];
if (!userId) {
  console.error("Usage: pnpm --filter @tvic/example-voice-mode token -- <user-id>");
  process.exitCode = 1;
} else {
  const secret = process.env.VOICE_AUTH_SECRET;
  if (!secret && isProductionEnv()) {
    console.error("VOICE_AUTH_SECRET is required in production");
    process.exitCode = 1;
  } else {
    console.log(createAppUserToken(userId, secret ?? "local-development-voice_auth_secret"));
  }
}
