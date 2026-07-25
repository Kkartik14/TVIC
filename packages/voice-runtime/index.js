/**
 * Public identity for the early voice-runtime preview.
 *
 * The executable createVoiceAgent API will land here once its contract is
 * stable enough for external users. Publishing this explicit preview avoids
 * presenting an unfinished runtime API as production-ready.
 */
export const voiceRuntime = Object.freeze({
  name: "voice-runtime",
  project: "TVIC",
  stage: "early-preview",
  repository: "https://github.com/Kkartik14/TVIC",
});
