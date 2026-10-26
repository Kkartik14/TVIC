import assert from "node:assert/strict";

import {
  PROVIDER_CAPABILITY_FEATURES,
  PROVIDER_NAMES,
  resolveProviderCapability,
} from "../packages/core/dist/index.js";
import {
  CARTESIA_CAPABILITY_FEATURES,
  ELEVENLABS_CAPABILITY_FEATURES,
  loadCartesiaCapabilitySnapshot,
  loadElevenLabsCapabilitySnapshot,
} from "../packages/providers/dist/index.js";

const SIMULATION_BASE_URL = (
  process.env.TVIC_PROVIDER_SIM_BASE_URL ?? "http://127.0.0.1:4300"
).replace(/\/$/u, "");
const scenario = process.argv[2] ?? "success";
const CARTESIA_VOICE = "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4";
const ELEVENLABS_VOICE = "voice-sim-123";
const ELEVENLABS_MODEL = "eleven_flash_v2_5";
const validUntil = new Date(Date.now() + 60_000).toISOString();

const cartesiaRequestStatus = scenario.startsWith("cartesia-")
  ? scenario.slice("cartesia-".length)
  : undefined;
const elevenLabsRequestStatus = scenario.startsWith("elevenlabs-")
  ? scenario.slice("elevenlabs-".length)
  : undefined;

const validScenarios = new Set([
  "success",
  "cartesia-408",
  "cartesia-429",
  "elevenlabs-408",
  "elevenlabs-429",
]);
if (!validScenarios.has(scenario)) {
  throw new Error("Use success, cartesia-408, cartesia-429, elevenlabs-408, or elevenlabs-429");
}

const cartesiaPromise = loadCartesiaCapabilitySnapshot({
  apiKey: "postman-simulation-cartesia-key",
  voiceIds: [CARTESIA_VOICE],
  modelIds: ["sonic-3.6"],
  validUntil,
  fetchImpl: simulationFetch("cartesia", cartesiaRequestStatus),
});
const elevenLabsPromise = loadElevenLabsCapabilitySnapshot({
  apiKey: "postman-simulation-elevenlabs-key",
  modelIds: [ELEVENLABS_MODEL],
  voiceIds: [ELEVENLABS_VOICE],
  validUntil,
  fetchImpl: simulationFetch("elevenlabs", elevenLabsRequestStatus),
});

const [cartesiaResult, elevenLabsResult] = await Promise.allSettled([
  cartesiaPromise,
  elevenLabsPromise,
]);

assertExpectedResult("Cartesia", cartesiaResult, cartesiaRequestStatus);
assertExpectedResult("ElevenLabs", elevenLabsResult, elevenLabsRequestStatus);

if (scenario === "success") {
  const cartesiaSnapshot = cartesiaResult.status === "fulfilled" ? cartesiaResult.value : undefined;
  const elevenLabsSnapshot =
    elevenLabsResult.status === "fulfilled" ? elevenLabsResult.value : undefined;
  assert.ok(cartesiaSnapshot);
  assert.ok(elevenLabsSnapshot);

  const cartesiaVoice = resolveProviderCapability([cartesiaSnapshot], {
    provider: PROVIDER_NAMES.cartesia,
    feature: PROVIDER_CAPABILITY_FEATURES.ttsVoiceAvailable,
    scope: "voice",
    model: "sonic-3.6",
    voice: CARTESIA_VOICE,
  });
  const elevenLabsVoice = resolveProviderCapability([elevenLabsSnapshot], {
    provider: PROVIDER_NAMES.elevenlabs,
    feature: PROVIDER_CAPABILITY_FEATURES.ttsVoiceAvailable,
    scope: "voice",
    model: ELEVENLABS_MODEL,
    voice: ELEVENLABS_VOICE,
  });
  const category = elevenLabsSnapshot.facts.find(
    (fact) => fact.feature === ELEVENLABS_CAPABILITY_FEATURES.ttsVoiceCategory,
  );
  const locales = elevenLabsSnapshot.facts.find(
    (fact) => fact.feature === ELEVENLABS_CAPABILITY_FEATURES.ttsVoiceVerifiedLocales,
  );
  const cartesiaPro = cartesiaSnapshot.facts.find(
    (fact) => fact.feature === CARTESIA_CAPABILITY_FEATURES.ttsVoiceIsPro,
  );

  assert.equal(cartesiaVoice.status, "supported");
  assert.equal(elevenLabsVoice.status, "supported");
  assert.deepEqual(category?.value, "high_quality");
  assert.equal(locales?.status, "supported");
  assert.deepEqual(locales?.value, ["en-US"]);
  assert.equal(cartesiaPro?.value, false);
  process.stdout.write(
    "snapshot success: Cartesia voice; ElevenLabs model, voice, high_quality, and valid locale\n",
  );
} else {
  process.stdout.write(`${scenario}: expected provider error and independent sibling success\n`);
}

function assertExpectedResult(name, result, status) {
  if (!status) {
    assert.equal(result.status, "fulfilled", `${name} request should succeed`);
    return;
  }

  assert.equal(result.status, "rejected", `${name} request should reject for HTTP ${status}`);
  const expectedCode = status === "429" ? "provider.rate_limited" : "provider.upstream_failed";
  assert.equal(result.reason?.code, expectedCode);
  assert.equal(result.reason?.retriable, true);
  assert.equal(result.reason?.metadata?.httpStatus, Number(status));
}

function simulationFetch(routeKey, responseStatus) {
  return (input, init = {}) => {
    const originalUrl = new URL(typeof input === "string" ? input : input.url);
    const mockUrl = `${SIMULATION_BASE_URL}/${routeKey}${originalUrl.pathname}${originalUrl.search}`;
    const headers = new Headers(
      init.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    if (responseStatus) headers.set("x-mock-response-code", responseStatus);
    return fetch(mockUrl, { ...init, headers });
  };
}
