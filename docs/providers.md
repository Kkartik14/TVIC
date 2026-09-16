# Providers, models, and credentials

TVIC separates the four runtime roles:

- Transport receives and sends media.
- STT converts speech to text.
- LLM produces text and tool calls.
- TTS converts text to speech.

Choose each role independently. A provider account, model, and voice are still
your responsibility. TVIC does not proxy provider credentials or make billing
decisions for your application.

## Maturity labels

These labels are TVIC release claims. They are not vendor guarantees.

| Label        | Meaning                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Stable       | The transport or adapter is included in the supported release path and has the required contract and live evidence for that release. |
| Experimental | Deterministic contract coverage exists, but the release does not make a broad live-service reliability claim.                        |
| Deferred     | The shape may exist in types or research, but TVIC does not claim an executable supported path.                                      |

As of the current release, Web Client Audio and inbound Twilio Media Streams are
stable transports. The paid STT, LLM, and TTS adapters are experimental. The
machine-readable values are exported as `PROVIDER_STABILITY`.

The catalog is dated evidence. Recheck the official provider documentation
before choosing a model for a production or purchasing decision.

## Current provider matrix

### Transports

| Role                | Adapter            | Stability | Credentials                                    | Notes                                                                            |
| ------------------- | ------------------ | --------- | ---------------------------------------------- | -------------------------------------------------------------------------------- |
| Browser audio       | `web-client-audio` | Stable    | Host application credentials                   | Server-side WebSocket bridge. Browser code does not import TVIC.                 |
| Inbound phone audio | `twilio`           | Stable    | Twilio account and host webhook authentication | Inbound Media Streams only. Outbound dialing is not implemented by this adapter. |

### Speech to text

| Provider          | Stability    | Environment variable | Catalog models           | Catalog verified |
| ----------------- | ------------ | -------------------- | ------------------------ | ---------------- |
| Deepgram          | Experimental | `DEEPGRAM_API_KEY`   | `nova-3`, `nova-2`       | 2026-09-15       |
| Sarvam            | Experimental | `SARVAM_API_KEY`     | `saaras:v3`, `saaras:v4` | 2026-09-15       |
| ElevenLabs Scribe | Experimental | `ELEVENLABS_API_KEY` | `scribe_v2_realtime`     | 2026-08-20       |
| AssemblyAI        | Experimental | `ASSEMBLYAI_API_KEY` | `u3-rt-pro`              | 2026-08-20       |
| Soniox            | Experimental | `SONIOX_API_KEY`     | `stt-rt-v5`              | 2026-08-20       |

### Language models

| Provider              | Stability    | Environment variable | Catalog models                                   | Catalog verified |
| --------------------- | ------------ | -------------------- | ------------------------------------------------ | ---------------- |
| Groq Chat Completions | Experimental | `GROQ_API_KEY`       | `openai/gpt-oss-20b`, `openai/gpt-oss-120b`      | 2026-09-15       |
| OpenAI Responses      | Experimental | `OPENAI_API_KEY`     | `gpt-5`, `gpt-5-mini`, `gpt-4.1`, `gpt-4.1-mini` | 2026-07-24       |

### Text to speech

| Provider   | Stability    | Environment variable | Required voice variable | Catalog models                                                     | Catalog verified |
| ---------- | ------------ | -------------------- | ----------------------- | ------------------------------------------------------------------ | ---------------- |
| Cartesia   | Experimental | `CARTESIA_API_KEY`   | `CARTESIA_VOICE_ID`     | `sonic-3`, `sonic-2`                                               | 2026-09-15       |
| ElevenLabs | Experimental | `ELEVENLABS_API_KEY` | `ELEVENLABS_VOICE_ID`   | `eleven_flash_v2_5`, `eleven_turbo_v2_5`, `eleven_multilingual_v2` | 2026-07-24       |

The dates above come from the current provider catalog in
`packages/providers/src/catalog.ts`. They are evidence dates, not promises that
the vendor will keep a model available.

## Configure from environment variables

The managed API reads credentials from the environment when `apiKey` is omitted:

```ts
import { createVoiceAgent } from "voice-runtime";

const agent = createVoiceAgent({
  prompt: "You are a helpful appointment assistant.",
  providers: {
    telephony: { provider: "web-client-audio" },
    stt: { provider: "deepgram" },
    llm: { provider: "groq" },
    tts: { provider: "cartesia" },
  },
  models: {
    stt: "nova-3",
    llm: "openai/gpt-oss-20b",
    tts: "sonic-3",
    ttsVoice: process.env.CARTESIA_VOICE_ID,
  },
});
```

Explicit credentials take precedence:

```ts
const agent = createVoiceAgent({
  prompt: "You are a helpful assistant.",
  providers: {
    telephony: { provider: "web-client-audio" },
    stt: { provider: "deepgram", apiKey: process.env.DEEPGRAM_API_KEY },
    llm: { provider: "groq", apiKey: process.env.GROQ_API_KEY },
    tts: {
      provider: "cartesia",
      apiKey: process.env.CARTESIA_API_KEY,
      voiceId: process.env.CARTESIA_VOICE_ID,
    },
  },
});
```

Do not put these values in browser JavaScript, source control, prompts, logs,
or tool arguments.

## Use constructed providers

Use provider instances when you need provider-specific options such as a custom
URL, endpointing settings, a clock for deterministic tests, or a WebSocket
factory:

```ts
import {
  createCartesiaTtsProvider,
  createDeepgramSttProvider,
  createGroqChatLlmProvider,
  createWebClientAudioProvider,
  createVoiceAgent,
} from "voice-runtime";

const telephony = createWebClientAudioProvider();
const stt = createDeepgramSttProvider({
  apiKey: process.env.DEEPGRAM_API_KEY!,
  endpointingMs: 300,
  vadEvents: true,
});
const llm = createGroqChatLlmProvider({
  apiKey: process.env.GROQ_API_KEY!,
  url: process.env.GROQ_API_URL,
});
const tts = createCartesiaTtsProvider({
  apiKey: process.env.CARTESIA_API_KEY!,
  voiceId: process.env.CARTESIA_VOICE_ID!,
});

const agent = createVoiceAgent({
  prompt: "You are a concise voice assistant.",
  providers: { telephony, stt, llm, tts },
});
```

## OpenAI Responses and compatible endpoints

The OpenAI adapter uses the Responses request and server-sent event format. It
accepts a custom `url`, so an endpoint can be configured when it implements the
same request and response shape:

```ts
const agent = createVoiceAgent({
  prompt: "You are a helpful assistant.",
  providers: {
    telephony: { provider: "web-client-audio" },
    stt: { provider: "deepgram" },
    llm: {
      provider: "openai",
      url: process.env.OPENAI_RESPONSES_URL,
      allowUnknownModel: true,
    },
    tts: { provider: "cartesia" },
  },
});
```

This is not a universal OpenAI-compatible adapter. A Chat Completions-only
endpoint will not work with the Responses adapter. Test the endpoint through a
real provider smoke test before making it a production dependency.

Groq uses its Chat Completions-compatible endpoint and also accepts a custom
`url`. Its current catalog models advertise function calling but not parallel
tool calls.

## Model validation

TVIC checks selected models against its dated catalog before opening a provider
stream. A custom or self-hosted deployment can opt out explicitly:

```ts
const agent = createVoiceAgent({
  prompt: "You are a helpful assistant.",
  providers: {
    telephony: { provider: "web-client-audio" },
    stt: { provider: "deepgram", allowUnknownModel: true },
    llm: { provider: "groq", allowUnknownModel: true },
    tts: { provider: "cartesia" },
  },
  models: {
    stt: "my-self-hosted-model",
    llm: "my-compatible-model",
  },
});
```

`allowUnknownModel` only disables the TVIC catalog check. It does not check that
the provider accepts the model, has the required capability, or will remain
available.

## Provider-specific notes

### Deepgram

The adapter uses a WebSocket stream with PCM16 audio, interim results, endpointing,
VAD events, and optional language and vocabulary settings. The default model is
`nova-3` and the default endpointing value is 300 milliseconds.

Official model information: <https://developers.deepgram.com/docs/models-languages-overview>

### Sarvam

The adapter uses the Sarvam realtime WebSocket protocol and supports partial and
final transcripts, VAD signals, and manual flush. The default model is
`saaras:v3`.

Official protocol information: <https://docs.sarvam.ai/api-reference/speech-to-text/transcribe/ws>

### ElevenLabs Scribe

This is the STT adapter. It is separate from the ElevenLabs TTS adapter even
though both use `ELEVENLABS_API_KEY`. The default realtime model is
`scribe_v2_realtime`.

Official realtime STT information: <https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime>

### AssemblyAI

The realtime STT adapter uses `u3-rt-pro` as its current catalog model and
normalizes provider turns into TVIC transcript events.

Official message sequence information: <https://www.assemblyai.com/docs/streaming/message-sequence>

### Soniox

The adapter uses the Soniox realtime WebSocket protocol and defaults to
`stt-rt-v5`. Soniox live testing is credential-gated and should be treated as an
explicit smoke-test task.

Official protocol information: <https://soniox.com/docs/api-reference/stt/websocket-api>

### Groq

The adapter consumes a streamed Chat Completions response and normalizes text,
tool calls, usage, and terminal errors. The default model is
`openai/gpt-oss-20b`.

Official model information: <https://console.groq.com/docs/models>

### OpenAI Responses

The adapter consumes streamed Responses events and supports text output and
function calls. The default catalog model is `gpt-4.1-mini`.

Official model information: <https://platform.openai.com/docs/models>

### Cartesia

Cartesia requires an API key and voice ID. The default model is `sonic-3`.
Incremental text is sent through the Cartesia synthesis session and output audio
is normalized at the TVIC boundary.

Official model information: <https://docs.cartesia.ai/build-with-cartesia/tts-models/older-models>

### ElevenLabs TTS

This is the TTS adapter. It requires an API key and voice ID. The default model
is `eleven_flash_v2_5`.

Official model information: <https://elevenlabs.io/docs/models>

## Live provider checks

The normal repository tests are hermetic and do not contact vendors. A live
provider check requires credentials, can incur charges, and should be run with a
short fixture and explicit time limits.

Use the repository scripts described in [Testing](./testing.md). Record the
provider, model, date, result, and any observed provider error. A passing mock
test is not evidence that a vendor connection works.
