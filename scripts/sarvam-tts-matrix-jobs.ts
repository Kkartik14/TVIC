import { createHash } from "node:crypto";

import { PROVIDER_CATALOG } from "../packages/providers/dist/index.js";
import type { SarvamTtsLanguage } from "../packages/providers/src/sarvam-tts-model.js";

import { SARVAM_TTS_SAMPLE_TEXT } from "./sarvam-tts-sample-text.js";
import {
  SARVAM_TTS_V4_FLASH_MODEL,
  SARVAM_TTS_V4_FLASH_VOICE_CASES,
} from "./sarvam-tts-v4-voices.js";

export type SarvamHttpTransport = "rest" | "http-stream";

const SARVAM_TTS_V4_DOCUMENTED_CROSS_LANGUAGE_CASES = [
  { voice: "aparna_hi_customer", language: "en-IN" },
] as const satisfies readonly { voice: string; language: SarvamTtsLanguage }[];

const SARVAM_TTS_V4_DOCUMENTED_HTTP_STREAM_CROSS_LANGUAGE_CASES = [
  { voice: "simran_en_customer", language: "hi-IN" },
] as const satisfies readonly { voice: string; language: SarvamTtsLanguage }[];

export interface SarvamTtsLiveMatrixJob {
  readonly index: number;
  readonly model: string;
  readonly voice: string;
  readonly language: SarvamTtsLanguage;
  readonly text: string;
  readonly file: string;
}

export interface SarvamTtsHttpMatrixJob extends SarvamTtsLiveMatrixJob {
  readonly transport: SarvamHttpTransport;
}

export function assertSarvamTtsMatrixModel(model: string): void {
  if (!PROVIDER_CATALOG.sarvamTts.models.some((supportedModel) => supportedModel === model)) {
    throw new Error(`unsupported Sarvam TTS model: ${model}`);
  }
}

export function createSarvamTtsLiveMatrixJobs(
  model: string,
  voices: readonly string[],
  languages: readonly SarvamTtsLanguage[],
): SarvamTtsLiveMatrixJob[] {
  assertSarvamTtsMatrixModel(model);
  const cases =
    model === SARVAM_TTS_V4_FLASH_MODEL
      ? [
          ...SARVAM_TTS_V4_FLASH_VOICE_CASES,
          ...SARVAM_TTS_V4_DOCUMENTED_CROSS_LANGUAGE_CASES,
        ].filter(
          (voiceCase) => voices.includes(voiceCase.voice) && languages.includes(voiceCase.language),
        )
      : voices.flatMap((voice) => languages.map((language) => ({ voice, language })));
  const jobs = cases.map(({ voice, language }, index) => ({
    index,
    model,
    voice,
    language,
    text: SARVAM_TTS_SAMPLE_TEXT[language],
    file: createSarvamTtsMatrixArtifactFile(
      model,
      voice,
      language,
      SARVAM_TTS_SAMPLE_TEXT[language],
    ),
  }));
  if (jobs.length === 0) throw new Error("Sarvam voice/language selection produced no cases");
  return jobs;
}

export function createSarvamTtsHttpMatrixJobs(
  model: string,
  transports: readonly SarvamHttpTransport[],
  voices: readonly string[],
  languages: readonly SarvamTtsLanguage[],
): SarvamTtsHttpMatrixJob[] {
  assertSarvamTtsMatrixModel(model);
  const jobs: SarvamTtsHttpMatrixJob[] = [];
  for (const transport of transports) {
    const personaCases =
      model === SARVAM_TTS_V4_FLASH_MODEL
        ? [
            ...SARVAM_TTS_V4_FLASH_VOICE_CASES,
            ...SARVAM_TTS_V4_DOCUMENTED_CROSS_LANGUAGE_CASES,
          ].filter(
            (voiceCase) =>
              voices.includes(voiceCase.voice) && languages.includes(voiceCase.language),
          )
        : voices.flatMap((voice) => languages.map((language) => ({ voice, language })));
    const documentedCrossLanguageCases =
      model === SARVAM_TTS_V4_FLASH_MODEL && transport === "http-stream"
        ? SARVAM_TTS_V4_DOCUMENTED_HTTP_STREAM_CROSS_LANGUAGE_CASES.filter(
            (voiceCase) =>
              voices.includes(voiceCase.voice) && languages.includes(voiceCase.language),
          )
        : [];
    const cases = [...personaCases, ...documentedCrossLanguageCases];
    for (const { voice, language } of cases) {
      jobs.push({
        index: jobs.length,
        model,
        transport,
        voice,
        language,
        text: SARVAM_TTS_SAMPLE_TEXT[language],
        file: createSarvamTtsMatrixArtifactFile(
          model,
          voice,
          language,
          SARVAM_TTS_SAMPLE_TEXT[language],
          transport,
        ),
      });
    }
  }
  if (jobs.length === 0) throw new Error("Sarvam voice/language selection produced no cases");
  return jobs;
}

export function createSarvamTtsMatrixArtifactFile(
  model: string,
  voice: string,
  language: string,
  text: string,
  transport?: SarvamHttpTransport,
): string {
  const transportSegment = transport === undefined ? "" : `-${transport}`;
  const identity = JSON.stringify([model, transport ?? null, voice, language, text]);
  const digest = createHash("sha256").update(identity).digest("hex");
  return `${fileModel(model)}${transportSegment}-${voice}-${language}-${digest}.wav`;
}

function fileModel(model: string): string {
  return model.replaceAll(":", "-");
}
