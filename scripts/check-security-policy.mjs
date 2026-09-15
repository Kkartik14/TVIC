import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function read(relativePath) {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const [twilioVerifier, browserVerifier, gateway, config, main, ingressTests, docs] =
  await Promise.all([
    read("packages/providers/src/twilio-webhooks.ts"),
    read("packages/providers/src/web-client-audio-webhooks.ts"),
    read("examples/live-call/src/gateway.ts"),
    read("examples/live-call/src/config.ts"),
    read("examples/live-call/src/main.ts"),
    read("examples/live-call/test/ingress.test.ts"),
    read("examples/live-call/README.md"),
  ]);

assert(!/skipVerification/u.test(twilioVerifier), "Twilio verifier exposes a bypass option");
assert(!/skipVerification/u.test(browserVerifier), "browser verifier exposes a bypass option");
assert(/replayStore:\s*TwimlReplayStore/u.test(gateway), "TwiML handler lacks a replay store");
assert(/twimlReplayKey/u.test(gateway), "TwiML handler lacks a stable replay key");
assert(/kind === "conflict"/u.test(gateway), "conflicting webhook retries are not rejected");
assert(/kind === "replayed"/u.test(gateway), "identical webhook retries are not replayed");
assert(/allowUnauthenticatedTwiml:\s*boolean/u.test(gateway), "development bypass is not explicit");
assert(
  /ALLOW_UNAUTHENTICATED_TWIML=true is forbidden in production/u.test(config),
  "production can enable unauthenticated TwiML",
);
assert(
  /TWILIO_AUTH_TOKEN is required in production/u.test(config),
  "production does not require Twilio authentication",
);
assert(
  /REDIS_URL is required in production/u.test(main),
  "production does not require shared replay storage",
);
assert(
  /concurrent duplicate deliveries/u.test(ingressTests),
  "concurrent replay coverage is missing",
);
assert(
  /without the identifiers required for replay protection/u.test(ingressTests),
  "identifier-boundary coverage is missing",
);
assert(
  /Production also requires `REDIS_URL`/u.test(docs),
  "live-call security documentation is incomplete",
);

process.stdout.write(
  "security policy ok: public bypasses removed and TwiML ingress fails closed\n",
);
