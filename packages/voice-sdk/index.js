/**
 * Public identity for the early voice-sdk preview.
 *
 * The executable createVoiceAgent API will land here once its contract is
 * stable enough for external users. Publishing this explicit preview avoids
 * presenting an unfinished runtime API as production-ready.
 */
export const voiceSdk = Object.freeze({
  name: "voice-sdk",
  project: "TVIC",
  stage: "early-preview",
  repository: "https://github.com/Kkartik14/TVIC",
});
