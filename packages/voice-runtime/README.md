# voice-runtime

[![npm](https://img.shields.io/npm/v/voice-runtime.svg)](https://www.npmjs.com/package/voice-runtime)
[![CI](https://github.com/Kkartik14/TVIC/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Kkartik14/TVIC/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

`voice-runtime` is the public npm entry point for
[TVIC](https://github.com/Kkartik14/TVIC), a provider-neutral runtime for realtime
voice agents with bring-your-own telephony, speech, model, and synthesis providers.

## Status

The package is the public Node.js entry point for the TVIC runtime. The first
release targets Node 20 through 26 and ships both ESM and CommonJS entry points.
It is server-side only: browser audio connects to a Node server through the
browser-audio transport adapter, while browser imports from this package remain
out of scope for the first release.

The stable managed API assembles the STT → LLM → TTS pipeline from a prompt and
provider configuration. The host application still owns its HTTP server,
webhook authentication, browser-session authentication, and domain tools.

This README describes the intended public contract; release status is tracked in
the repository's `local/release/1.0.0/checklist.md`.

## Install

```sh
npm install voice-runtime
```

The package has no provider SDK lock-in. You may use the built-in adapters, pass
your own provider implementations, or mix both approaches.

## Prompt-first agent

```ts
import { createVoiceAgent } from "voice-runtime";

const agent = createVoiceAgent({
  prompt: "You schedule appointments for Dr. Kartik. Be concise and confirm the time.",
  providers: {
    telephony: { provider: "web-client-audio" },
    stt: { provider: "deepgram", apiKey: process.env.DEEPGRAM_API_KEY },
    llm: {
      provider: "openai",
      apiKey: process.env.OPENAI_API_KEY,
      model: "gpt-4.1-mini",
    },
    tts: {
      provider: "cartesia",
      apiKey: process.env.CARTESIA_API_KEY,
      voiceId: process.env.CARTESIA_VOICE_ID,
    },
  },
});

// `callHandle` comes from a verified transport connection or your own adapter.
const session = await agent.start({
  callHandle,
  channel: "web_audio",
});

for await (const event of session.run) {
  if (event.kind === "transcript_delta") console.log("caller:", event.text);
  if (event.kind === "error") console.error(event.error);
}

const result = await session.run;
console.log(result.turnsHandled);
await agent.stop();
```

`agent.start()` returns `{ sessionId, run }`. The `run` value is both an async
event stream and an awaitable final result. The separate envelope is required by
JavaScript Promise assimilation rules; returning the Promise-like run directly
from an async `start()` method would make `await agent.start()` lose the session
handle. Use `agent.run(options)` when you only need the final result.

TVIC does not receive media from a prompt alone. A verified transport adapter
must produce the `callHandle` passed to `start()`.

For a built-in Web Client Audio or Twilio adapter, use the factory form so the
adapter receives the session ID created by TVIC:

```ts
import { createTwilioMediaStreamsProvider, createVoiceAgent } from "voice-runtime";

const telephony = createTwilioMediaStreamsProvider();

const session = await agent.start({
  call: verifiedInboundCall,
  channel: "phone",
  callHandle: ({ sessionId, call }) => telephony.acceptWebSocket(socket, call.id, sessionId),
});
```

The factory runs after the runtime session exists and receives
`{ sessionId, call, channel }`. The supplied call is required in this form, and
its ID must match the returned handle's `callId`. Replace the provider and
`channel` with `createWebClientAudioProvider()` and `"web_audio"` for browser
audio. A preconstructed custom `CallHandle` is also supported when the adapter
already knows how to correlate its events to the managed session.

`agent.stop()` is idempotent. If a session is still running, it cancels and
drains that session before closing the runtime and its stores.

Errors on `VoiceEvent` and `MediaEvent` payloads are JSON-safe
`NormalizedError` values. Check them with `isNormalizedError`; the
`isTvicError` marker is reserved for thrown `TvicThrowableError` wrappers and
is not present on plain event payloads.

TVIC-created error codes use lowercase, namespaced identifiers such as
`auth.invalid_key` and `provider.open_failed`. Custom calls to
`normalizedError()` and `normalizeUnknownError()` must use one or more
lowercase dot-separated segments; older persisted error records retain their
legacy codes during migration.

## What TVIC does

Accepts call media, transcribes speech, decides when a caller actually finished
their turn, runs a model and tools, synthesizes a reply incrementally, streams audio
back, and handles interruption, cancellation, provider stalls, and hangup.

Recordings, traces, incident analysis, and dashboards are deliberately out of scope.
Those belong to Earshot, a separate voice observability product that integrates
outside the realtime critical path.

## Providers, models, and credentials

Each stage is configured independently. Built-in options currently include:

- STT: Deepgram, Sarvam, ElevenLabs Scribe, AssemblyAI, and Soniox.
- LLM: OpenAI Responses.
- TTS: Cartesia and ElevenLabs.
- Transport: browser audio and inbound Twilio Media Streams.

Maturity is intentionally explicit: Web Client Audio and inbound Twilio Media
Streams are the stable transport candidates for `1.0.0`. The paid STT, LLM,
and TTS adapters are currently `experimental`—their deterministic protocol
coverage passes, but each still needs a credential-gated live-service check
before release notes can call it stable. The root export `PROVIDER_STABILITY`
contains the machine-readable labels.

Pass an explicit `apiKey` or use the documented environment variable. Explicit
credentials take precedence; missing credentials fail before a live session is
created.

| Provider   | Environment variable |
| ---------- | -------------------- |
| Deepgram   | `DEEPGRAM_API_KEY`   |
| Sarvam     | `SARVAM_API_KEY`     |
| ElevenLabs | `ELEVENLABS_API_KEY` |
| AssemblyAI | `ASSEMBLYAI_API_KEY` |
| Soniox     | `SONIOX_API_KEY`     |
| OpenAI     | `OPENAI_API_KEY`     |
| Cartesia   | `CARTESIA_API_KEY`   |

STT, LLM, and TTS models are independent settings. TTS voice selection is also
independent. Built-in TTS can read `CARTESIA_VOICE_ID` or
`ELEVENLABS_VOICE_ID` for its voice. For complete provider-specific control,
pass a constructed provider instance instead of a built-in configuration object.
Built-in STT and OpenAI-compatible LLM configurations reject models outside the
dated TVIC catalog unless `allowUnknownModel: true` is explicitly set.

Tools are application-owned functions. Define their schema and executor once,
then include them in the agent:

```ts
import { createVoiceAgent, defineTool } from "voice-runtime";

const bookAppointment = defineTool<{ date: string }, { booked: boolean }>({
  id: "book_appointment",
  name: "book_appointment",
  description: "Books an appointment for a requested date.",
  inputSchema: { type: "object", required: ["date"] },
  outputSchema: { type: "object", required: ["booked"] },
  async execute(input) {
    // Call your application service here; TVIC does not own domain state.
    return { booked: input.date.length > 0 };
  },
});

const providers = {
  telephony: { provider: "web-client-audio" as const },
  stt: { provider: "deepgram" as const, apiKey: process.env.DEEPGRAM_API_KEY },
  llm: { provider: "openai" as const, apiKey: process.env.OPENAI_API_KEY },
  tts: {
    provider: "cartesia" as const,
    apiKey: process.env.CARTESIA_API_KEY,
    voiceId: process.env.CARTESIA_VOICE_ID,
  },
};

const agentWithTools = createVoiceAgent({
  prompt: "Schedule appointments and use the booking tool when needed.",
  tools: [bookAppointment],
  providers,
});
```

Tool execution receives a session/turn-scoped `AbortSignal`; authorization,
confirmation for irreversible actions, and domain-state writes remain the host
application's responsibility.

## Composable API

Advanced runtime, media, provider, normalized-error, and durable-adapter APIs
are exported from the package root. There are no advanced subpath imports in the
first release. This lets a developer start with `createVoiceAgent` and later own
the runtime/session/pipeline boundaries without changing package names.

The host remains responsible for creating authenticated transport connections,
owning HTTP/webhook lifecycle, and implementing application-domain tools. TVIC
does not automatically create public unauthenticated endpoints or choose a
provider fallback policy.

## Persistence adapters

The root also exposes the PostgreSQL and Redis durability building blocks. The
database drivers are intentionally injected, so install and configure `pg` and
`redis` in your application:

```ts
import {
  createPostgresMemory,
  createPostgresRedisDurableRuntimeStore,
  runPostgresMemoryMigrations,
  runPostgresMigrations,
} from "voice-runtime";

await runPostgresMigrations(pgPool);
await runPostgresMemoryMigrations(memoryPool);
const memory = createPostgresMemory({ pool: memoryPool });
const durable = createPostgresRedisDurableRuntimeStore({
  pool: pgPool,
  redis: redisClient,
});
```

The migration SQL is bundled into the published package and can also be
inspected in the package's migration sources. Run each migration function once
at deploy time; repeated calls are idempotent. PostgreSQL is authoritative for
the composite store, while Redis is used for its cache/projection layer.

## License

[Apache-2.0](./LICENSE)
