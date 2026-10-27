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

Hosts implementing custom text-to-speech adapters can follow the
[provider author guide](./provider-author-guide.md) for selection hooks and
preflight behavior.

### Evidence and test ladder

The repository has multiple kinds of confidence. They must not be collapsed into
one “tests passed” statement:

| Evidence level    | How it is produced                                                                                | What it proves                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Contract          | `pnpm lint`, `pnpm test`, and `pnpm build` with hermetic fixtures.                                | Our adapter obeys TVIC's declared shapes, bounds, errors, cancellation, and teardown behavior. |
| Live smoke        | `pnpm providers:live-smoke -- ./speech.wav` with selected `.env` credentials.                     | A selected provider/model can answer a bounded real request now.                               |
| ElevenLabs matrix | `pnpm elevenlabs:live-model-smoke [./speech.wav]` with `.env` credentials.                        | Every catalogued ElevenLabs TTS and Scribe model is exercised on its actual transport.         |
| Golden path       | `pnpm provider:smoke` with Deepgram -> Groq -> Cartesia and the public Web Client transport.      | The selected cascaded composition works end to end, including cancellation and shutdown.       |
| Small-scale       | Repeated live smoke plus normal, cancellation, close, and transport-playout scenarios.            | The exact path is reasonable for low-volume use, subject to its documented limitations.        |
| Release           | Dated evidence, exact support matrix, known limitations, rollback path, and maintainer ownership. | TVIC can make a stable release claim for the declared scope.                                   |

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

As of `2.0.0`, Web Client Audio and inbound Twilio Media Streams are stable
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

| Provider          | Stability    | Environment variable | Catalog models                                                                   | Catalog verified |
| ----------------- | ------------ | -------------------- | -------------------------------------------------------------------------------- | ---------------- |
| Deepgram          | Experimental | `DEEPGRAM_API_KEY`   | `nova-3`, `nova-2`                                                               | 2026-09-15       |
| Cartesia Ink      | Experimental | `CARTESIA_API_KEY`   | realtime: `ink-2`, `ink-preview`, `ink-whisper-2025-06-04`; batch: `ink-whisper` | 2026-10-27       |
| Sarvam            | Experimental | `SARVAM_API_KEY`     | `saaras:v3`, `saaras:v4`                                                         | 2026-10-27       |
| ElevenLabs Scribe | Experimental | `ELEVENLABS_API_KEY` | `scribe_v2`, `scribe_v2_realtime`, `scribe_v2_medical`                           | 2026-10-27       |
| AssemblyAI        | Experimental | `ASSEMBLYAI_API_KEY` | Realtime: U3.6/U3.5/English/Multilingual; pre-recorded: U3.5/U2; Sync: U3.5      | 2026-10-24       |
| Soniox            | Experimental | `SONIOX_API_KEY`     | `stt-rt-v5`                                                                      | 2026-08-20       |

### Language models

| Provider              | Stability    | Environment variable | Catalog models                                   | Catalog verified |
| --------------------- | ------------ | -------------------- | ------------------------------------------------ | ---------------- |
| Groq Chat Completions | Experimental | `GROQ_API_KEY`       | `openai/gpt-oss-20b`, `openai/gpt-oss-120b`      | 2026-09-15       |
| OpenAI Responses      | Experimental | `OPENAI_API_KEY`     | `gpt-5`, `gpt-5-mini`, `gpt-4.1`, `gpt-4.1-mini` | 2026-07-24       |

### Text to speech

| Provider   | Stability    | Environment variable | Required voice variable    | Catalog models                                                                                                                               | Catalog verified |
| ---------- | ------------ | -------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Cartesia   | Experimental | `CARTESIA_API_KEY`   | `CARTESIA_VOICE_ID`        | `sonic-3.6`, `sonic-3.6-2026-08-27`, `sonic-preview`, `sonic-3.5`, `sonic-3.5-2026-05-04`, `sonic-3`, `sonic-3-2026-01-12`                   | 2026-10-27       |
| ElevenLabs | Experimental | `ELEVENLABS_API_KEY` | `ELEVENLABS_VOICE_ID`      | v3, v3 Conversational, v4 (REST and WebSocket dialogue), v4 Turbo (WebSocket dialogue), Multilingual v2, Flash v2/2.5, retained Turbo v2/2.5 | 2026-10-27       |
| Sarvam     | Experimental | `SARVAM_API_KEY`     | Optional (`shubh` default) | `bulbul:v3` and `bulbul:v4-flash` (WebSocket, REST, HTTP stream; classic and persona voice catalogs)                                         | 2026-10-27       |

The dates above come from the current provider catalog in
`packages/providers/src/catalog.ts`. They are evidence dates, not promises that
the vendor will keep a model available.

## Session usage reporting

Managed sessions expose a transient usage summary on `finalSession`; the same
snapshot may appear on `SessionEndEvent` and the metadata-only runtime trace.
Usage entries are grouped by the provider operation and model. Runtime-measured
values are distinct from provider-reported values. A missing or malformed
provider value is marked not reported, never treated as zero. TVIC does not add
prices, currency, or vendor billing estimates, and it does not persist usage to
the session store.

The machine-readable `PROVIDER_CATALOG[provider].usage.routes` data is the
route-level source for each field, transport, evidence source, verification date,
and original provider unit. It distinguishes `live`, `batch`, and `sync` routes;
batch and sync usage does not enter a live session summary.

### Speech-to-text usage

`audioMsSent` is measured by TVIC from audio bytes and format after each physical
provider write succeeds. Successful reconnect replays count again; queued audio,
failed writes, and unconfirmed writes do not. Provider-reported values remain
separate when they describe different things or are not proven additive.

| Adapter route                   | Runtime measured | Provider-reported or unavailable figures                                                                                                                                                                                                             |
| ------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deepgram realtime               | `audioMsSent`    | `providerAudioMs` from terminal `Metadata.duration` (provider seconds normalized to milliseconds); immediate hangup may close the stream before it arrives. Reconnect generations remain bounded per-stream observations because replay can overlap. |
| Cartesia Ink manual realtime    | `audioMsSent`    | `providerAudioMs` from each final transcript's `duration`; retained as per-message observations, not summed.                                                                                                                                         |
| Cartesia Ink auto-turn realtime | `audioMsSent`    | Provider duration is unverified for this route; do not reuse the manual route's claim.                                                                                                                                                               |
| Sarvam realtime                 | `audioMsSent`    | `providerAudioDuration` and `providerProcessingDuration` from `data.metrics`; raw provider-defined units and per-message observations, kept separate and not summed.                                                                                 |
| ElevenLabs Scribe realtime      | `audioMsSent`    | No provider duration field is documented for the realtime event route. Transcript timestamps are alignment, not audio consumed.                                                                                                                      |
| AssemblyAI realtime             | `audioMsSent`    | `providerAudioMs` and `providerSessionMs` from `Termination`; audio processed and connection duration are distinct, each connection is retained as a bounded observation, and immediate hangup may prevent the terminal event.                       |
| Soniox realtime                 | `audioMsSent`    | `providerFinalAudioProcessedMs` and `providerTotalAudioProcessedMs`; the provider defines different audio-processing scopes, so retain both separately.                                                                                              |

The runtime never waits after hangup solely to collect a provider usage event.
Provider metrics that do not arrive before the synchronous session snapshot is
frozen are reported as interrupted or unavailable. Cartesia and ElevenLabs
batch transcription, AssemblyAI pre-recorded transcription, and AssemblyAI Sync
are separate offline operations and do not contribute to live-session totals.

### Language-model usage

The runtime counts each `complete()` invocation, including an additional request
after tool execution. It counts neither hidden retries inside a provider nor a
single tool continuation as one combined request.

| Adapter               | Runtime measured | Provider-reported                                                                                                                                                              |
| --------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Groq Chat Completions | `requestCount`   | `inputTokens`, `outputTokens`, and optional `cachedTokens` from the streaming usage chunk, including Groq's `x_groq.usage` form. A usage-bearing terminal chunk may be absent. |
| OpenAI Responses      | `requestCount`   | `inputTokens`, `outputTokens`, and optional `cachedTokens` from `response.usage` when present. Incomplete responses may have no usage object.                                  |

`cachedTokens` is a subset of `inputTokens`, not an additional count. A
provider-reported token field remains unavailable if the adapter cannot validate
its value; valid sibling fields are preserved.

### Text-to-speech usage

All live TTS routes report runtime-measured `charactersSent` and
`audioMsReceived`. `charactersSent` counts Unicode code points in text at each
synthesis-method invocation, including a failover wrapper's actual child
attempts even when an attempt rejects. It is a TVIC measure of submitted text,
not provider receipt or billing. `audioMsReceived` is derived from PCM frames
read from the provider stream; it does not mean the transport accepted or played
that audio.

The catalog lists provider character and audio-duration fields separately for
each route. The reviewed ElevenLabs standard HTTP Convert route reports the
provider `character-cost` response header, kept separate from runtime
`charactersSent`; the provider's counting algorithm is not inferred. No
reviewed TTS route reports a provider audio-duration total. Other character
metrics remain not reported or unverified as recorded in the route catalog.

When `createTtsFailoverProvider()` is explicitly composed, its summary entry is
grouped under the wrapper. Runtime text counts use an unknown model because a
request may reach multiple child models. Provider-reported observations keep a
child-reported model when one is supplied. The wrapper reports each actual child
synthesis attempt and forwards child provider observations without exposing the
child's provider identity in the summary.

ElevenLabs Scribe uses two adapter paths: `scribe_v2_realtime` opens the
realtime WebSocket through `open()`, while `scribe_v2` and `scribe_v2_medical`
use the exported provider's bounded `transcribe()` batch method. ElevenLabs
`eleven_v3` and `eleven_v3_conversational` use the vendor's Text-to-Dialogue
protocol by default; Multilingual v2, Flash v2/2.5, and retained Turbo models
use regular Text-to-Speech. The adapter does not silently substitute a model or
transport. Turbo models are retained for compatibility, although ElevenLabs
recommends their Flash replacements.

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
    tts: "sonic-3.6",
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

The managed API forwards a non-empty legacy `sttLanguage` string to the adapter
without BCP-47 normalization or policy preflight. Host-written providers may
continue to use values such as `hi_IN` or `multi`; the managed API rejects an
empty string. The explicit `sttLanguagePolicy` path is normalized and checked
against the configured adapter's declared support.
`strictness: "best_effort"` is provider-specific: Soniox maps it to
`language_hints_strict: false`; adapters without that wire behavior reject it.

STT vocabulary is included in provider requests. Deepgram, Cartesia, ElevenLabs,
AssemblyAI, and Sarvam send it in WebSocket URL query parameters; proxy or
provider logs may therefore expose the terms. Soniox sends vocabulary in its
WebSocket context payload. Avoid secrets and personal data in vocabulary terms.

### Deepgram

The adapter uses a WebSocket stream with PCM16 audio, interim results, endpointing,
VAD events, and optional language and vocabulary settings. The default model is
`nova-3` and the default endpointing value is 300 milliseconds.
The normalized `sttLanguagePolicy` accepts model-specific fixed language tags
from Deepgram's model matrix. Hint policies are available on multilingual
`nova-3`; they reduce regional tags to the primary language. The canonical BCP-47
tag `fil` is mapped to Deepgram's `tl`. The legacy `sttLanguage` field continues
to pass raw provider values through.

Official model information: <https://developers.deepgram.com/docs/models-languages-overview>

### Sarvam

The adapter uses the Sarvam realtime WebSocket protocol and supports partial and
final transcripts, VAD signals, and manual flush. The default model is
`saaras:v3`.

Official protocol information: <https://docs.sarvam.ai/api-reference/speech-to-text/transcribe/ws>

### ElevenLabs Scribe

This is the STT adapter. It is separate from the ElevenLabs TTS adapter even
though both use `ELEVENLABS_API_KEY`. The default realtime model is
`scribe_v2_realtime`; `scribe_v2` and `scribe_v2_medical` are exposed through
the adapter's batch-only `transcribe()` method. The adapter rejects attempts to
open a batch model over WebSocket or send the realtime model through HTTP.

Realtime options include manual/VAD commit strategy, language hints, secondary
languages, VAD thresholds, keyterms, no-verbatim mode, background-audio
filtering, zero-retention logging, previous-text context, timestamps/language
detection, and entity detection. Realtime keyterms are capped at 50 entries and
20 characters per entry. When timestamp or language metadata is requested, the
adapter waits for the delayed committed metadata event before emitting the
final segment. When entity detection is enabled, it likewise waits for and
attaches bounded entity records under `metadata.elevenlabs.entities`.
For `languagePolicy.mode: "hints"`, the first language is sent as the primary
`language_code`; remaining languages are sent as `secondary_languages` in the
same order.

Batch `transcribe()` accepts keyterms, audio-event tagging, diarization,
timestamps, entity detection, and no-verbatim mode for both batch models. The
shared adapter contract intentionally supports 16 kHz PCM16 mono input only;
the live runner resamples a supplied mono PCM WAV to that format. Batch audio
must contain at least 100 ms of complete PCM samples.

Official realtime STT information: <https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime>
Official realtime event reference: <https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/event-reference>
Official batch STT information: <https://elevenlabs.io/docs/api-reference/speech-to-text/convert>

### AssemblyAI

`AssemblyAiSttProvider` covers all three current AssemblyAI STT surfaces:

- `open()` uses the realtime WebSocket. It defaults to `universal-3-6-pro` and
  accepts `universal-3-5-pro`, `universal-streaming-english`, and
  `universal-streaming-multilingual`.
- `transcribe()` uploads local bytes when needed, submits a pre-recorded job,
  polls it to completion, and accepts `universal-3-5-pro` or `universal-2`.
  Pass `model` for one model or `speechModels` for the documented ordered
  fallback list.
- `transcribeSync()` sends raw PCM16LE in the Sync multipart request and
  currently accepts `universal-3-5-pro`; `transcribeSyncLive()` sends the same
  config plus an async PCM chunk source to `/v1/transcribe/live`; `warmSync()`
  primes the Sync service.

The realtime adapter accepts 16 kHz PCM16 mono frames. Its `commit()` flushes the
final buffered audio and sends AssemblyAI's `ForceEndpoint` control message.
`close()` flushes and waits for pending audio writes within a two-second budget,
then sends the documented `Terminate` message. If a write stalls past that
budget, it rejects that write and force-closes the socket while allowing the
requested close to finish. Sync accepts 80 ms through
120 seconds of PCM16LE mono or stereo audio; pre-recorded accepts a public URL or
uploaded bytes and retains the provider's bounded response for fields TVIC has
not promoted yet. Pre-recorded requests also support speaker diarization,
multichannel transcription, contextual/keyterm prompting, and PII redaction
configuration. Realtime requests support keyterms, contextual prompting,
language detection, and speaker diarization metadata. The legacy raw
`sttLanguage` value is included in the realtime contextual prompt; explicit
language policies use the model's language-code field and are available only on
the supported Universal-3 Pro models. Model IDs are validated per transport, so
a realtime-only model cannot accidentally be sent to pre-recorded or Sync.

Official AssemblyAI documentation: [STT overview](https://www.assemblyai.com/docs),
[realtime model selection](https://www.assemblyai.com/docs/streaming/select-the-speech-model),
[pre-recorded model selection](https://www.assemblyai.com/docs/pre-recorded-audio/select-the-speech-model),
[pre-recorded transcription](https://www.assemblyai.com/docs/pre-recorded-audio/getting-started/transcribe-an-audio-file),
[speaker diarization](https://www.assemblyai.com/docs/pre-recorded-audio/label-speakers),
[multichannel transcription](https://www.assemblyai.com/docs/pre-recorded-audio/transcribe-multiple-audio-channels),
[PII redaction](https://www.assemblyai.com/docs/guardrails/redact-pii-from-transcripts),
[Sync quickstart](https://www.assemblyai.com/docs/sync-stt/getting-started/transcribe-a-short-audio-file),
[Sync live upload](https://www.assemblyai.com/docs/sync-stt/getting-started/transcribe-live-audio),
and [realtime message sequence](https://www.assemblyai.com/docs/streaming/message-sequence).

Official message sequence information: <https://www.assemblyai.com/docs/streaming/message-sequence>

### Soniox

The adapter uses the Soniox realtime WebSocket protocol and defaults to
`stt-rt-v5`. Soniox live testing is credential-gated and should be treated as an
explicit smoke-test task.

`sttLanguagePolicy: { mode: "fixed" }` sets a strict language hint. A `hints`
policy with `strictness: "best_effort"` sends `language_hints_strict: false`,
so the provider may still detect speech outside the hints. Omitting
`strictness` leaves Soniox's default behavior unchanged. The legacy raw
`sttLanguage` request remains a provider hint and does not set strict mode.
Custom `webSocketFactory` implementations must forward the supplied
`Authorization` header. The adapter does not use Soniox's deprecated start-frame
`api_key` field, which Soniox plans to stop accepting on 15 January 2027; see its
[authentication migration guide](https://soniox.com/docs/guides/migrate-websocket-authentication).
For Tagalog, the language policy accepts the canonical `fil` tag and maps it to
Soniox's `tl` code.

Official protocol information: <https://soniox.com/docs/api-reference/stt/websocket-api>

### Cartesia Ink STT

The Cartesia STT adapter supports the current Ink family: `ink-2` (the default),
`ink-preview`, and the dated `ink-whisper-2025-06-04` snapshot. It accepts
16 kHz mono PCM16LE over WebSocket and keeps the provider's model, language,
keyterms, and transcript metadata bounded at the adapter boundary.
The Ink Whisper language policy accepts canonical `fil` and sends Cartesia's
Tagalog code, `tl`. It maps Bokmål (`nb`) to Cartesia's `no` code and preserves
Nynorsk (`nn`) as its separately supported code.

The default `manual` mode uses Cartesia's `/stt/websocket` endpoint. TVIC maps
the session commit operation to Cartesia's `finalize` command and maps
`flush_done` to a TVIC manual endpoint. Set `mode: "auto"` to use
`/stt/turns/websocket` and Ink's native turn lifecycle (`turn.start`,
`turn.update`, `turn.eager_end`, `turn.resume`, and `turn.end`). Auto mode
supports `ink-2`; `ink-preview` and the dated Ink Whisper snapshot use the
manual-finalize endpoint. The adapter remains Experimental until the exact
model/mode path earns TVIC's live evidence threshold.

Managed configuration reads `CARTESIA_API_KEY` when no explicit key is passed:

```ts
const agent = createVoiceAgent({
  prompt: "You are a concise voice assistant.",
  providers: {
    telephony: { provider: "web-client-audio" },
    stt: { provider: "cartesia", mode: "manual" },
    llm: { provider: "groq" },
    tts: { provider: "cartesia" },
  },
  models: {
    stt: "ink-2",
    llm: "openai/gpt-oss-20b",
    tts: "sonic-3.6",
    ttsVoice: process.env.CARTESIA_VOICE_ID,
  },
});
```

For a native-turn session, change the STT configuration to
`{ provider: "cartesia", mode: "auto" }`. For complete files, call the same
provider's `transcribe()` method with `model: "ink-whisper"`; TVIC sends
multipart form data to Cartesia's HTTP `/stt` endpoint and returns the complete
text plus optional word timestamps. `capabilities.batch` advertises this
operation and `capabilities.batchModels` exposes its model constraint to generic
downstream code. Batch is not used by TVIC's live cascaded topology.

Official model information: <https://docs.cartesia.ai/build-with-cartesia/stt/latest>
Official endpoint comparison: <https://docs.cartesia.ai/use-the-api/stt/compare-endpoints>
Official turn events: <https://docs.cartesia.ai/use-the-api/stt/turns>
Official batch reference: <https://docs.cartesia.ai/api-reference/stt/transcribe>

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

Cartesia requires an API key and voice ID. The default model is `sonic-3.6`; use
`sonic-3.6-2026-08-27` when reproducible model behavior matters. `sonic-preview`
is available for evaluation but is not a production model. Older `sonic-3.5` and
`sonic-3` models remain selectable for compatibility; `sonic-2` and its snapshots
are scheduled for retirement by Cartesia and are not in the current catalog.

TVIC uses Cartesia's native incremental WebSocket endpoint. It preserves one
context across text chunks, acknowledges explicit flush boundaries, and maps
word/phoneme timing events into the TVIC event contract. The adapter sends a
plain Cartesia voice ID, uses API version `2026-08-14`, and requests raw
`pcm_s16le` at 16 kHz so output is already at TVIC's normalized audio boundary.
The adapter owns continuation buffering by default (`maxBufferDelayMs: 0`) and
supports Cartesia's optional `locale`, `accent`, `normalization`, pronunciation
dictionary, and `generationConfig` controls. It remains Experimental until the
provider/model/transport path earns TVIC's validated evidence threshold.
Cartesia requires Sonic 3.6 or newer for `locale`; older models receive the
base language instead. Unknown models accept a syntactically valid configured
language when `allowUnknownModel` is enabled; the vendor remains responsible
for validating that model's actual language support.

`voiceCatalogSnapshot` is optional. With a snapshot, TVIC preflights overrides
against its active voice records; a 404 is retained as a `missing` record rather
than failing the entire snapshot. Without a snapshot, syntactically valid
per-call voice IDs pass through to Cartesia for provider-side resolution. A
snapshot is checked when the provider instance is created and again for each
call. A stale snapshot is treated as absent, so configured voice IDs and
provider-managed per-call voices keep working after its 24-hour lifetime.
Without a fresh snapshot, a configured `generationConfig.speed` needs only
Cartesia's 0.6–1.5 range. Per-call speed overrides require fresh voice metadata
that confirms a compatible non-professional voice.

`fetchCartesiaVoiceCatalogSnapshot()` accepts an optional `signal` to cancel the
lookup. Authentication failures retain the provider auth error code.

Official model information: <https://docs.cartesia.ai/build-with-cartesia/tts-models/latest>
Official WebSocket reference: <https://docs.cartesia.ai/api-reference/tts/websocket>

### ElevenLabs TTS

This is the TTS adapter family. It requires an API key and voice ID. The default
model is `eleven_flash_v2_5`. Every supported path requests the provider's
`pcm_16000` wire format and emits the runtime's normalized `pcm_s16le`, mono,
16 kHz format.

TVIC covers the complete ElevenLabs speech-generation transport surface:

| Factory                                 | ElevenLabs surface                                   | Use it for                                                                      |
| --------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------- |
| `createElevenLabsTtsProvider`           | Regular TTS WebSocket and Text-to-Dialogue WebSocket | Incremental agent text, flush/finish lifecycle, alignment, v3 multi-voice turns |
| `createElevenLabsTtsRestProvider`       | Complete TTS/Dialogue HTTP plus timestamped variants | One-shot generation and request stitching                                       |
| `createElevenLabsTtsHttpStreamProvider` | Chunked TTS/Dialogue HTTP plus timestamped variants  | Low-buffer server-side piping and HTTP cancellation                             |
| `createElevenLabsMultiContextProvider`  | TTS or v3 Text-to-Dialogue multi-context WebSocket   | Up to five independent contexts multiplexed on one connection                   |

The HTTP adapter exposes `synthesizeSpeech()` for the regular single-voice
endpoint and `synthesizeDialogue()` for explicit multi-voice requests. Its
ordinary `synthesize()` route selects Text-to-Dialogue for v3 and v4 models and
regular TTS for other models. v4 Turbo is available on the WebSocket dialogue
route; TVIC does not expose it through HTTP or HTTP streaming. Timestamped
responses become `tts.alignment` events, and
request-stitching fields (`previousText`, `nextText`, `previousRequestIds`, and
`nextRequestIds`) are passed through with bounded validation.

The provider-specific options expose the documented streaming controls: seed
(0 is valid for regular TTS; v3 dialogue seeds start at 1),
text normalization, zero-retention logging, SSML parsing, inactivity timeout,
regular-WebSocket auto mode and chunk schedule, and up to three pronunciation
dictionaries. v3 and v4 single-context dialogue sessions can register voices through `dialogueVoices`
and send a turn with `sendDialogueTurn({ voiceId, newTurn })`; conversational v3
and v4 Turbo accept one registered voice, while v3 and v4 accept up to ten.
HTTP dialogue requests are limited to 2,000 total text characters. The v4
WebSocket context limit is 10,000 characters; v4 Turbo has no separate TVIC
character cap. Dialogue sessions also expose `keepAlive()` for the provider's
receive timeout.

For v3 dialogue, the adapter sends only the supported stability setting; it
rejects speed and similarity overrides before connecting because ElevenLabs does
not expose those settings for v3.
For other catalog models, supported speed is 0.7–1.2. v4 dialogue and v3
dialogue do not accept speed. With `allowUnknownModel`, TVIC permits that range
for custom models outside the dialogue protocols.

`knownVoiceIds` and `dialogueVoices` optionally enable strict preflight for
per-call voices. When the relevant list is omitted, syntactically valid voice
IDs retain the legacy provider-resolved behavior. Supplying a list makes TVIC
reject overrides that are not in that list before network activity. A custom
fixed regular-TTS `url` needs a `:voice_id` placeholder to route a per-call
override. Dialogue requests carry their registered voice IDs in the request
body, so they do not need that path placeholder.

`eleven_multilingual_v2` does not accept `language_code`. For compatibility,
TVIC accepts a configured or per-call language for that model and omits it from
the provider request.

TVIC maps BCP-47 language tags to the primary language code in `language_code`
(for example, `hi-IN` becomes `hi`). Flash and Turbo use their finite language
tables. The v3/v4 documentation describes 70+ and 90+ languages with
representative lists, so TVIC accepts syntactically valid BCP-47 tags for those
model families and leaves vendor language handling to ElevenLabs.

Multi-context dialogue currently supports ElevenLabs v3 models only; v4 and v4
Turbo are rejected for this route. It enforces the provider's five-context
connection limit and v3's voice-registration rules.

ElevenLabs also offers MP3, Opus, μ-law, A-law, and WAV output. They are not
silently mislabeled as TVIC PCM: the provider-neutral media boundary is PCM-only,
so this adapter requests PCM and rejects callers asking for another normalized
format. Text is passed through unchanged, so callers remain
responsible for locale-aware number, date, URL, symbol, and abbreviation
normalization; v3 audio tags and punctuation are preserved as prompt text.

Official model information: <https://elevenlabs.io/docs/overview/models>
Official TTS overview: <https://elevenlabs.io/docs/overview/capabilities/text-to-speech>
Official complete TTS reference: <https://elevenlabs.io/docs/api-reference/text-to-speech/convert>
Official TTS HTTP stream reference: <https://elevenlabs.io/docs/api-reference/text-to-speech/stream>
Official TTS timestamp reference: <https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps>
Official TTS WebSocket reference: <https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream-input>
Official TTS multi-context WebSocket reference: <https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-multi-stream-input>
Official Text-to-Dialogue HTTP reference: <https://elevenlabs.io/docs/api-reference/text-to-dialogue/convert>
Official Text-to-Dialogue HTTP stream reference: <https://elevenlabs.io/docs/api-reference/text-to-dialogue/stream>
Official Text-to-Dialogue reference: <https://elevenlabs.io/docs/api-reference/text-to-dialogue/ttd-websocket>
Official Text-to-Dialogue multi-context reference: <https://elevenlabs.io/docs/api-reference/text-to-dialogue/ttd-multi-websocket>
Official request-stitching guide: <https://elevenlabs.io/docs/eleven-api/guides/how-to/text-to-speech/request-stitching>
Official TTS best practices: <https://elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices>

### Sarvam TTS

Sarvam TTS exposes Bulbul v3's classic speaker catalog and Bulbul v4 Flash's
persona voice catalog. V3 supports 11 language codes; v4 Flash requires a
caller-selected language and a supported persona voice. Every adapter normalizes successful output to TVIC's
`linear16`, mono, 16 kHz media boundary and rejects unsupported formats or
malformed provider audio instead of passing compressed bytes downstream.

TVIC exposes all three Sarvam delivery choices:

| Factory                             | Sarvam endpoint               | Best fit                                                                    | Input/output behavior                                                                                                  |
| ----------------------------------- | ----------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `createSarvamTtsProvider`           | WebSocket                     | Voice agents and multi-turn incremental text                                | Persistent bidirectional session; v3/v4 models; 2,500-character request limit; provider `final` flush acknowledgements |
| `createSarvamTtsRestProvider`       | `POST /text-to-speech`        | Complete text where a JSON response is convenient                           | One request; v3/v4 models; base64-encoded WAV in JSON; 2,500-character limit                                           |
| `createSarvamTtsHttpStreamProvider` | `POST /text-to-speech/stream` | Server-side piping, proxies, serverless, and one-shot low-buffer generation | One request; v3/v4 models; binary WAV response streamed as chunks; 3,500-character limit                               |

The REST adapter decodes the returned base64 WAV. The HTTP stream adapter parses
the WAV header incrementally, emits PCM chunks as the binary response arrives,
and supports cancellation by aborting the request. Both adapters send
`api-subscription-key`, model, language, speaker, pace, temperature, sample rate,
and optional `dict_id`. The WebSocket adapter remains the path for incremental
LLM text, repeated turns, and explicit buffering/flush control; HTTP streaming
does not replace that lifecycle.

Per-call `ttsSpeed` maps to Sarvam's `pace` and must be in the 0.5–2.0 range.
Bulbul v4 requires a persona voice and language. Sarvam accepts the `ml-IN` and
`od-IN` language codes, but its current v4 persona catalog does not list
Malayalam or Odia voices. TVIC validates a voice-language pair only when the
host supplies the optional `voiceLanguages` map; without that map, Sarvam does
the final compatibility check. The model guide lists v4 personas for Hindi,
English, English-Hindi, Bengali, Gujarati, Kannada, Marathi, Punjabi, Tamil, and
Telugu. TVIC does not hard-code that list as a language restriction for every
persona.

The optional `voiceLanguages` provider setting is a record from persona voice
IDs to arrays of language tags, for example
`{ simran_en_customer: ["en-IN"] }`. It can contain at most 128 voice IDs and
applies to WebSocket, REST, and HTTP-stream adapters. This is host-supplied
preflight data; omit the map when Sarvam should be the authority for voice and
language pairs.

The public config also supports `transport: "websocket" | "rest" |
"http-stream"` when using the managed runtime. The default remains WebSocket so
existing agents do not change behavior. TVIC exposes `bulbul:v3` and
`bulbul:v4-flash`; the legacy `bulbul:v2` path is not exposed.

Official model information: <https://docs.sarvam.ai/api/getting-started/models/bulbul>
Official TTS overview: <https://docs.sarvam.ai/api/api-guides-tutorials/text-to-speech/overview>
Official API selection guide: <https://docs.sarvam.ai/api/api-guides-tutorials/text-to-speech/which-api-to-use>
Official voice catalog: <https://docs.sarvam.ai/api/api-guides-tutorials/text-to-speech/voices>
Official REST reference: <https://docs.sarvam.ai/api-reference/text-to-speech/convert>
Official REST stream reference: <https://docs.sarvam.ai/api-reference/text-to-speech/convert-stream>
Official WebSocket reference: <https://docs.sarvam.ai/api-reference/text-to-speech/stream>
Official HTTP streaming guide and REST-vs-WebSocket comparison: <https://docs.sarvam.ai/api/api-guides-tutorials/text-to-speech/streaming-api/http-stream>
Official streaming guide: <https://docs.sarvam.ai/api/api-guides-tutorials/text-to-speech/streaming-api/web-socket>
Official credits and rate limits: <https://docs.sarvam.ai/api/getting-started/ratelimits>

## Live provider checks

The normal repository tests are hermetic and do not contact vendors. A live
provider check requires credentials, can incur charges, and should be run with a
short fixture and explicit time limits.

Use the repository scripts described in [Testing](./testing.md). Record the
provider, model, date, result, and any observed provider error. A passing mock
test is not evidence that a vendor connection works.
