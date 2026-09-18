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

Maturity belongs to an exact TVIC adapter path. A provider name, vendor account,
or model appearing in the catalog does not make every combination stable.

| Level        | What exists                                                                                   | What users may assume                                                                                   |
| ------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Deferred     | Types, research, or a proposed shape only; there is no supported executable path.             | Do not build an application on it. It may change or disappear without a compatibility promise.          |
| Experimental | An executable adapter with deterministic contract tests and bounded failure behavior.         | Good for development and evaluation. Live vendor behavior, credentials, and availability are unproven.  |
| Validated    | Experimental requirements plus live evidence for the exact adapter, model, and configuration. | Reasonable for prototypes and small-volume use with the documented limitations. No uptime or SLA claim. |
| Stable       | Validated evidence plus a release support matrix, operational ownership, and upgrade policy.  | Supported for the exact declared scope. This still does not promise vendor uptime or pricing.           |

The machine-readable values are exported as `PROVIDER_STABILITY`; the ordered
levels are exported as `PROVIDER_STABILITY_LEVELS`. These values describe TVIC's
support claim, not the vendor's marketing or service-level guarantee.

### Evidence and test ladder

The repository has multiple kinds of confidence. They must not be collapsed into
one “tests passed” statement:

| Evidence level | How it is produced                                                                                | What it proves                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Contract       | `pnpm lint`, `pnpm test`, and `pnpm build` with hermetic fixtures.                                | Our adapter obeys TVIC's declared shapes, bounds, errors, cancellation, and teardown behavior. |
| Live smoke     | `pnpm providers:live-smoke -- ./speech.wav` with selected `.env` credentials.                     | A selected provider/model can answer a bounded real request now.                               |
| Golden path    | `pnpm provider:smoke` with Deepgram -> Groq -> Cartesia and the public Web Client transport.      | The selected cascaded composition works end to end, including cancellation and shutdown.       |
| Small-scale    | Repeated live smoke plus normal, cancellation, close, and transport-playout scenarios.            | The exact path is reasonable for low-volume use, subject to its documented limitations.        |
| Release        | Dated evidence, exact support matrix, known limitations, rollback path, and maintainer ownership. | TVIC can make a stable release claim for the declared scope.                                   |

The small-scale profile is intentionally modest but explicit. Before a path can
be called `validated`, it must have all contract evidence, two independent live
runs on different dates, and a complete cascaded run for the exact model and
configuration. The live runs must cover startup, a normal streamed turn, and
clean cancellation or close. Malformed frames, authentication failures, timeouts,
queue limits, write failures, and unexpected provider closure are covered by the
hermetic contract suite; they do not require deliberately damaging a paid service.

For an external paid provider path, before calling it `stable`, maintainers
additionally require an exact adapter/model/transport/capability support matrix,
documented known limitations, an owner and rollback procedure, and at least ten
successful sessions and fifty turns observed over a seven-day window. A stable
transport may use deterministic protocol, security, and replay evidence instead;
that does not claim carrier or vendor uptime. These numbers are release evidence,
not a statistical reliability guarantee or vendor SLA. A stable label is withdrawn
or reduced when a supported model is deprecated, a correctness or security defect
is found, or repeated live evidence no longer matches the declared contract. TVIC
must never silently switch models, providers, or topologies during demotion.

As of `1.1.0`, Web Client Audio and inbound Twilio Media Streams are stable
transports. The paid STT, LLM, and TTS adapters are experimental; no paid adapter
has yet earned the `validated` label in the release metadata. OpenAI Responses
remains an experimental compatibility adapter and is not part of the recommended
provider path.

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
