import {
  composeSpeechControlCatalogSnapshot,
  PROVIDER_NAMES,
  type SpeechControlCatalogSnapshot,
  type SpeechControlFact,
} from "@tvic/core";

import { assemblyAiSupportsTurnTakingProfile } from "./assemblyai-stt.js";
import { cartesiaTtsLanguagesForModel } from "./cartesia-options.js";
import {
  cartesiaSupportsPronunciationDictionaries,
  cartesiaSupportsTextNormalization,
  cartesiaSupportsTtsTextOperations,
} from "./cartesia-tts-text.js";
import { PROVIDER_CATALOG } from "./catalog.js";
import {
  elevenLabsTtsLanguagesForModel,
  supportsElevenLabsTtsSpeed,
} from "./elevenlabs-options.js";
import {
  SARVAM_TTS_VOICES,
  sarvamTtsLanguagesForModel,
  sarvamTtsSpeedSupported,
} from "./sarvam-tts-model.js";
import {
  SARVAM_TTS_V4_FLASH_MODEL,
  SARVAM_TTS_V4_FLASH_VOICES,
  SARVAM_TTS_V4_FLASH_VOICE_CASES,
} from "./sarvam-tts-v4-voices.js";

const CARTESIA_MODELS_SOURCE = "https://docs.cartesia.ai/build-with-cartesia/tts-models/latest";
const CARTESIA_CONTROLS_SOURCE =
  "https://docs.cartesia.ai/build-with-cartesia/capability-guides/advanced-capabilities";
const CARTESIA_SPEED_SOURCE = "https://docs.cartesia.ai/api-reference/tts/bytes";
const CARTESIA_PRONUNCIATION_SOURCE =
  "https://docs.cartesia.ai/build-with-cartesia/capability-guides/custom-pronunciations";
const ELEVENLABS_MODELS_SOURCE = "https://elevenlabs.io/docs/api-reference/models/list";
const ELEVENLABS_TTS_SOURCE = "https://elevenlabs.io/docs/api-reference/text-to-speech/convert";
const ELEVENLABS_PRONUNCIATION_SOURCE =
  "https://elevenlabs.io/docs/eleven-api/guides/how-to/text-to-speech/pronunciation-dictionaries";
const SARVAM_BULBUL_SOURCE = "https://docs.sarvam.ai/api/getting-started/models/bulbul";
const SARVAM_VOICES_SOURCE =
  "https://docs.sarvam.ai/api/api-guides-tutorials/text-to-speech/voices";
const ASSEMBLYAI_TURN_SOURCE =
  "https://www.assemblyai.com/blog/turn-detection-endpointing-voice-agent";
const VERIFIED_AT = "2026-10-25";

export const PROVIDER_STATIC_SPEECH_CONTROL_FACTS: readonly SpeechControlFact[] = Object.freeze(
  buildStaticFacts().map(freezeFact),
);

export interface CreateProviderSpeechControlCatalogSnapshotOptions {
  readonly fetchedAt: string;
  readonly validUntil: string;
  readonly accountSnapshots?: readonly SpeechControlCatalogSnapshot[];
}

export function createProviderSpeechControlCatalogSnapshot(
  options: CreateProviderSpeechControlCatalogSnapshotOptions,
): SpeechControlCatalogSnapshot {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("Provider speech-control snapshot options must be an object");
  }
  const fetchedAtMs = parseTimestamp(options?.fetchedAt, "fetchedAt");
  const validUntilMs = parseTimestamp(options.validUntil, "validUntil");
  return composeSpeechControlCatalogSnapshot(
    PROVIDER_STATIC_SPEECH_CONTROL_FACTS,
    options.accountSnapshots ?? [],
    {
      fetchedAt: new Date(fetchedAtMs).toISOString(),
      validUntil: new Date(validUntilMs).toISOString(),
    },
  );
}

function buildStaticFacts(): SpeechControlFact[] {
  const facts: SpeechControlFact[] = [];
  addCartesiaFacts(facts);
  addSarvamFacts(facts);
  addElevenLabsFacts(facts);
  addAssemblyAiFacts(facts);
  return facts;
}

function addCartesiaFacts(facts: SpeechControlFact[]): void {
  for (const model of PROVIDER_CATALOG.cartesia.models) {
    addModelFact(facts, PROVIDER_NAMES.cartesia, "tts.model", model, true, CARTESIA_MODELS_SOURCE);
    addModelFact(facts, PROVIDER_NAMES.cartesia, "tts.speed", model, true, CARTESIA_SPEED_SOURCE, {
      min: 0.6,
      max: 1.5,
      requiresAccountVoiceFact: true,
    });
    const languages = cartesiaTtsLanguagesForModel(model);
    addModelFact(
      facts,
      PROVIDER_NAMES.cartesia,
      "tts.language",
      model,
      languages !== undefined,
      CARTESIA_MODELS_SOURCE,
      undefined,
      languages,
    );
    addModelFact(
      facts,
      PROVIDER_NAMES.cartesia,
      "tts.text_operations",
      model,
      cartesiaSupportsTtsTextOperations(model, []),
      CARTESIA_CONTROLS_SOURCE,
      { maxOperations: 32, operations: "spell,pause_after" },
    );
    addModelFact(
      facts,
      PROVIDER_NAMES.cartesia,
      "tts.text_normalization",
      model,
      cartesiaSupportsTextNormalization("auto", model),
      CARTESIA_CONTROLS_SOURCE,
      { modes: "auto,off,locale" },
    );
    addModelFact(
      facts,
      PROVIDER_NAMES.cartesia,
      "tts.pronunciation_dictionary",
      model,
      cartesiaSupportsPronunciationDictionaries([{ id: "catalog-probe" }], model),
      CARTESIA_PRONUNCIATION_SOURCE,
      { maxDictionaries: 1, versioned: false },
    );
  }
}

function addSarvamFacts(facts: SpeechControlFact[]): void {
  for (const model of PROVIDER_CATALOG.sarvamTts.models) {
    addModelFact(facts, PROVIDER_NAMES.sarvamTts, "tts.model", model, true, SARVAM_BULBUL_SOURCE);
    addModelFact(
      facts,
      PROVIDER_NAMES.sarvamTts,
      "tts.speed",
      model,
      sarvamTtsSpeedSupported(
        1,
        model,
        model === SARVAM_TTS_V4_FLASH_MODEL ? SARVAM_TTS_V4_FLASH_VOICES[0] : undefined,
      ),
      SARVAM_BULBUL_SOURCE,
      { min: 0.5, max: 2.0 },
    );
    const languages = sarvamTtsLanguagesForModel(model);
    addModelFact(
      facts,
      PROVIDER_NAMES.sarvamTts,
      "tts.language",
      model,
      languages !== undefined,
      SARVAM_BULBUL_SOURCE,
      undefined,
      languages,
    );
    addModelFact(
      facts,
      PROVIDER_NAMES.sarvamTts,
      "tts.text_operations",
      model,
      false,
      SARVAM_BULBUL_SOURCE,
    );
    const voices =
      model === SARVAM_TTS_V4_FLASH_MODEL ? SARVAM_TTS_V4_FLASH_VOICES : SARVAM_TTS_VOICES;
    for (const voice of voices) {
      facts.push({
        provider: PROVIDER_NAMES.sarvamTts,
        control: "tts.voice",
        scope: { type: "voice", model, voice },
        status: "supported",
        mutability: "call",
        source: SARVAM_VOICES_SOURCE,
        verifiedAt: VERIFIED_AT,
      });
    }
  }
  for (const voiceCase of SARVAM_TTS_V4_FLASH_VOICE_CASES) {
    facts.push({
      provider: PROVIDER_NAMES.sarvamTts,
      control: "tts.language",
      scope: { type: "voice", model: SARVAM_TTS_V4_FLASH_MODEL, voice: voiceCase.voice },
      status: "supported",
      mutability: "call",
      source: SARVAM_VOICES_SOURCE,
      verifiedAt: VERIFIED_AT,
      languages: [voiceCase.language],
    });
  }
}

function addElevenLabsFacts(facts: SpeechControlFact[]): void {
  for (const model of PROVIDER_CATALOG.elevenlabs.models) {
    addModelFact(
      facts,
      PROVIDER_NAMES.elevenlabs,
      "tts.model",
      model,
      true,
      ELEVENLABS_MODELS_SOURCE,
    );
    const languages = elevenLabsTtsLanguagesForModel(model);
    addModelFact(
      facts,
      PROVIDER_NAMES.elevenlabs,
      "tts.language",
      model,
      languages.length > 0,
      ELEVENLABS_TTS_SOURCE,
      undefined,
      languages,
    );
    const supportsSpeed = supportsElevenLabsTtsSpeed(1, model);
    addModelFact(
      facts,
      PROVIDER_NAMES.elevenlabs,
      "tts.speed",
      model,
      supportsSpeed,
      ELEVENLABS_TTS_SOURCE,
      supportsSpeed ? { min: 0.7, max: 1.2 } : undefined,
    );
    addModelFact(
      facts,
      PROVIDER_NAMES.elevenlabs,
      "tts.text_operations",
      model,
      false,
      ELEVENLABS_TTS_SOURCE,
    );
    addModelFact(
      facts,
      PROVIDER_NAMES.elevenlabs,
      "tts.pronunciation_dictionary",
      model,
      true,
      ELEVENLABS_PRONUNCIATION_SOURCE,
      { maxDictionaries: 3 },
    );
  }
  facts.push({
    provider: PROVIDER_NAMES.elevenlabs,
    control: "tts.text_normalization",
    scope: { type: "provider" },
    status: "supported",
    mutability: "call",
    source: ELEVENLABS_TTS_SOURCE,
    verifiedAt: VERIFIED_AT,
    limits: { modes: "auto,on,off" },
  });
}

function addAssemblyAiFacts(facts: SpeechControlFact[]): void {
  for (const model of PROVIDER_CATALOG.assemblyai.realtimeModels ?? []) {
    addModelFact(
      facts,
      PROVIDER_NAMES.assemblyaiStt,
      "stt.turn_taking_profile",
      model,
      assemblyAiSupportsTurnTakingProfile(model, "balanced"),
      ASSEMBLYAI_TURN_SOURCE,
      { profiles: "latency,balanced,accuracy" },
    );
  }
}

function addModelFact(
  facts: SpeechControlFact[],
  provider: string,
  control: string,
  model: string,
  supported: boolean,
  source: string,
  limits?: Readonly<Record<string, number | string | boolean>>,
  languages?: readonly string[],
): void {
  facts.push({
    provider,
    control,
    scope: { type: "model", model },
    status: supported ? "supported" : "unsupported",
    mutability: "call",
    source,
    verifiedAt: VERIFIED_AT,
    ...(limits !== undefined ? { limits } : {}),
    ...(languages !== undefined ? { languages } : {}),
  });
}

function freezeFact(fact: SpeechControlFact): SpeechControlFact {
  return Object.freeze({
    ...fact,
    scope: Object.freeze({ ...fact.scope }),
    ...(fact.limits !== undefined ? { limits: Object.freeze({ ...fact.limits }) } : {}),
    ...(fact.languages !== undefined ? { languages: Object.freeze([...fact.languages]) } : {}),
  });
}

function parseTimestamp(value: string, label: string): number {
  if (typeof value !== "string") throw new TypeError(`Speech-control ${label} must be a timestamp`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new TypeError(`Speech-control ${label} is invalid`);
  return timestamp;
}
