import {
  TvicVoiceClient,
  type TvicVoiceClientEventMap,
  type TvicVoiceClientError,
  type TvicVoiceMode,
} from "../public/voice-client.js";

const client = new TvicVoiceClient({
  gatewayUrl: "https://voice.example.test",
  appToken: "public-sample-token",
  mode: "continuous",
});

client.addEventListener("connected", (event) => {
  const sessionRef: string = event.detail.sessionRef;
  const expiration: number = event.detail.expMs;
  const mode: TvicVoiceMode = event.detail.mode;
  void [sessionRef, expiration, mode];
});

client.addEventListener("audio", (event) => {
  const sequence: number = event.detail.sequence;
  const durationMs: number = event.detail.durationMs;
  void [sequence, durationMs];
});

client.addEventListener("ended", (event) => {
  const reason: string = event.detail.reason;
  void reason;
});

client.addEventListener("error", (event) => {
  const message: string = event.detail.message;
  const code: string | undefined = event.detail.code;
  void [message, code];
});

const lastSessionRef: string | undefined = client.lastSessionRef;
const lastEndReason: string | undefined = client.lastEndReason;
const lastError: TvicVoiceClientError | undefined = client.lastError;
void client.connect(lastSessionRef === undefined ? {} : { supersedes: lastSessionRef });
void [lastSessionRef, lastEndReason, lastError];

type PublicEventMap = TvicVoiceClientEventMap;
const closedEvent: PublicEventMap["closed"] | undefined = undefined;
void closedEvent;
