# Building a voice agent

This guide explains how to turn one prompt, a provider selection, and an
authenticated transport into a working voice agent.

TVIC supports two ways to build:

1. The managed API, which is the shortest path from a prompt to a complete
   cascaded voice loop.
2. The composable API, which lets you own the runtime, session, media, and
   provider boundaries yourself.

Start with the managed API. Move to the composable API when your application
needs a custom pipeline or a boundary that the managed facade does not expose.

## The mental model

Every live session has these parts:

```text
authenticated transport
        |
        v
input audio -> STT -> turn policy -> LLM and tools -> TTS -> output audio
        ^                                                   |
        |                                                   v
        +------------ interruption and playout ------------+
```

The transport is the connection to a browser, phone call, or custom media
source. STT means speech to text. LLM means language model. TTS means text to
speech.

The prompt defines behavior. It does not authenticate users, grant tool
permissions, open a socket, or create a phone call.

## Create the managed agent

The managed API is exported from the package root:

```ts
import { createVoiceAgent } from "voice-runtime";

const agent = createVoiceAgent({
  id: "appointment-agent",
  name: "Appointment Agent",
  version: "1.0.0",
  prompt: `
You are an appointment assistant for a doctor

Your goals:
1. Understand why the caller is calling.
2. Collect their name and preferred appointment window.
3. Use the appointment tools when information is complete.
4. Read the final details back to the caller before making a booking.

Keep spoken replies short. Ask one question at a time. Never claim that an
appointment was booked unless the booking tool succeeded.
  `.trim(),
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

The managed constructor validates the prompt, provider kinds, audio formats,
models, voices, tool requirements, and provider capabilities. A bad
configuration fails before a session is created.

## Choose providers and models

You can pass a provider configuration object:

```ts
const agent = createVoiceAgent({
  prompt: "You are a concise customer support assistant.",
  providers: {
    telephony: { provider: "twilio" },
    stt: { provider: "deepgram", apiKey: process.env.DEEPGRAM_API_KEY },
    llm: { provider: "openai", apiKey: process.env.OPENAI_API_KEY },
    tts: {
      provider: "elevenlabs",
      apiKey: process.env.ELEVENLABS_API_KEY,
      voiceId: process.env.ELEVENLABS_VOICE_ID,
    },
  },
  models: {
    stt: "nova-3",
    llm: "gpt-4.1-mini",
    tts: "eleven_flash_v2_5",
  },
});
```

Or construct provider instances when you need provider-specific options:

```ts
import {
  createCartesiaTtsProvider,
  createDeepgramSttProvider,
  createGroqChatLlmProvider,
  createTwilioMediaStreamsProvider,
  createVoiceAgent,
} from "voice-runtime";

const telephony = createTwilioMediaStreamsProvider();
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
  prompt: "You are a helpful phone assistant.",
  providers: { telephony, stt, llm, tts },
});
```

### Add explicit TTS failover

Provider routing stays in the host application. If Sarvam is the preferred
voice and ElevenLabs is the operational fallback, compose the two adapters
before passing the result to `createVoiceAgent`:

```ts
import {
  createElevenLabsTtsHttpStreamProvider,
  createSarvamTtsHttpStreamProvider,
  createTtsFailoverProvider,
  createVoiceAgent,
} from "voice-runtime";

const sarvam = createSarvamTtsHttpStreamProvider({
  apiKey: process.env.SARVAM_API_KEY!,
  voiceId: "shubh",
  language: "en-IN",
});
const elevenLabs = createElevenLabsTtsHttpStreamProvider({
  apiKey: process.env.ELEVENLABS_API_KEY!,
  voiceId: process.env.ELEVENLABS_VOICE_ID!,
  modelId: "eleven_flash_v2_5",
});

const tts = createTtsFailoverProvider({
  primary: sarvam,
  fallback: elevenLabs,
  mapFallbackRequest: (request) => ({
    ...request,
    model: "eleven_flash_v2_5",
    voice: process.env.ELEVENLABS_VOICE_ID!,
  }),
  onFallback: ({ phase, error }) => {
    console.warn(`TTS fallback phase=${phase} code=${error.code}`);
  },
});

const agent = createVoiceAgent({
  prompt: "You are a concise customer-support assistant.",
  providers: {
    telephony: { provider: "web-client-audio" },
    stt: { provider: "deepgram" },
    llm: { provider: "groq" },
    tts,
  },
  models: {
    tts: "bulbul:v3",
    ttsVoice: "shubh",
  },
});
```

This is an explicit host-owned policy. By default, failover covers operational
provider, network, timeout, and rate-limit failures; it does not hide invalid
requests, authentication errors, protocol errors, cancellation, or identity
bugs. The request mapper changes only provider-specific fields such as the
model and voice. If the primary stream fails before emitting audio, the
fallback is attempted. Once audio has been delivered, TVIC propagates the
failure instead of replaying the response and risking duplicate speech.

The HTTP-stream adapters preserve streaming output, but the wrapper intentionally
does not expose `openSession()`. The managed pipeline therefore synthesizes a
completed model response through `synthesize()` rather than using incremental
sentence-to-TTS input. If incremental input is required, implement the same
policy around both providers' `TtsSession` lifecycle and decide how to replay
text that was accepted before a failure.

When a model is not supplied, TVIC uses the provider catalog default. The
precedence is:

1. `models` on `createVoiceAgent`.
2. The model in the provider configuration.
3. The model selected by the constructed provider.
4. The dated TVIC catalog default.

Catalog validation is strict by default. A deliberately configured custom
endpoint can opt out with `allowUnknownModel: true`. This only disables TVIC's
dated model-list check. It does not prove that the endpoint supports the
provider protocol.

See the [provider guide](./providers.md) for the current catalog and maturity
labels.

## Connect a transport

The managed agent needs a `CallHandle`. A handle is the runtime's transport
boundary. It supplies an async stream of inbound events and methods for sending,
clearing, and closing output.

For a preconstructed handle:

```ts
const session = await agent.start({
  callHandle,
  channel: "simulated",
});
```

For a built-in transport whose handle must know the TVIC session ID, use a
factory:

```ts
import { createWebClientAudioProvider } from "voice-runtime";

const webClientAudio = createWebClientAudioProvider();

const session = await agent.start({
  call: verifiedCall,
  channel: "web_audio",
  callHandle: ({ sessionId, call, signal }) =>
    webClientAudio.acceptWebSocket(socket, call.id, sessionId),
});
```

The factory receives a deeply frozen call snapshot and an abort signal. The
signal is aborted when startup is cancelled, the caller aborts, or the agent is
stopped. The returned handle's `callId` must match `call.id`.

The application must authenticate the connection before creating the handle.
The [transport guide](./transports.md) describes the browser and Twilio flows.

## Consume the session

`start()` returns a session envelope:

```ts
const session = await agent.start({
  callHandle,
  channel: "simulated",
});

console.log(session.sessionId);
```

`session.run` is both an async event stream and an awaitable final result. Start
one event consumer and await the same run:

```ts
const eventsFinished = (async () => {
  for await (const event of session.run) {
    switch (event.kind) {
      case "transcript_delta":
        console.log("caller:", event.text);
        break;
      case "audio_output":
        // Send to application-level playback only if your handle does not
        // already own output delivery.
        console.log("audio bytes:", event.bytes.byteLength);
        break;
      case "tool_call":
        console.log("tool call:", event.toolName, event.input);
        break;
      case "tool_result":
        console.log("tool result:", event.output);
        break;
      case "error":
        console.error(event.error.code, event.error.message);
        break;
      case "turn_started":
      case "turn_completed":
      case "call_ended":
        break;
    }
  }
})();

try {
  const result = await session.run;
  await eventsFinished;
  console.log({
    turnsHandled: result.turnsHandled,
    interruptions: result.interruptions,
    terminalReason: result.terminalReason,
  });
} finally {
  await agent.stop();
}
```

The event stream can report a recoverable error while the session continues.
The final result is the authoritative terminal outcome. If the run rejects,
handle the normalized error and still stop the agent.

Do not create two event iterators for the same run. One iterator owns public
event delivery. Multiple awaits are safe.

If you only need the final result, use:

```ts
const result = await agent.run({ callHandle, channel: "simulated" });
```

## Write a useful prompt

Voice prompts work best when they specify behavior that can be observed in a
conversation:

- State the agent's role and audience.
- State the actual goal of the call.
- Describe the order of information to collect.
- Tell the agent when to ask a follow-up question.
- State which actions require confirmation.
- Tell the agent what it must never claim.
- Keep spoken replies short and natural.
- Put data from your application in context variables or memory, not in source
  code string concatenation.

The prompt is not an authorization policy. A caller can attempt to override it,
and a language model can make mistakes. Enforce permissions in every tool and
validate tool input and output.

## Add tools

Define tools with schemas and an executor:

```ts
import { defineTool } from "voice-runtime";

const findAppointment = defineTool<{ date: string }, { date: string; times: string[] }>({
  id: "find_appointment",
  name: "find_appointment",
  description: "Find available appointment times for a date.",
  inputSchema: {
    type: "object",
    properties: { date: { type: "string" } },
    required: ["date"],
  },
  outputSchema: {
    type: "object",
    properties: {
      date: { type: "string" },
      times: { type: "array", items: { type: "string" } },
    },
    required: ["date", "times"],
  },
  timeout: { timeoutMs: 5_000, onTimeout: "fail" },
  async execute(input, context) {
    if (!context.tenant?.userId) {
      throw new Error("The caller identity is required");
    }
    return { date: input.date, times: ["09:00", "11:30"] };
  },
});
```

Include it when creating the agent:

```ts
const agent = createVoiceAgent({
  prompt: "Help callers schedule appointments. Use find_appointment when needed.",
  tools: [findAppointment],
  providers: {
    telephony: { provider: "web-client-audio" },
    stt: { provider: "deepgram" },
    llm: { provider: "groq" },
    tts: { provider: "cartesia", voiceId: process.env.CARTESIA_VOICE_ID },
  },
});
```

Tool execution receives a session and turn identity, an attempt number, a
logger, an abort signal, and optional tenant identity. Use the tenant identity
to enforce application authorization. The `authScope` field is retained for
compatibility but is not an authorization engine.

For actions that can be repeated after a network failure, configure idempotency.
For actions that may take time, configure a timeout. Retry only operations that
are safe to repeat.

## Handle interruptions correctly

A caller speaking while the agent is talking is an interruption. The runtime can
cancel model generation, clear queued audio, and wait for transport playout
evidence when the transport provides it.

The default interruption policy is graceful interruption with a 200 millisecond
minimum speech duration and output trimming enabled. Set it explicitly when the
application needs a different policy:

```ts
const agent = createVoiceAgent({
  prompt: "You are a concise assistant.",
  interruptionPolicy: {
    mode: "graceful",
    minSpeechMs: 250,
    trimOutputOnInterrupt: true,
  },
  providers,
});
```

Do not treat a provider write as proof that the caller heard the audio. A
transport with `confirmPlayout()` can report that distinction. The final turn
state reflects the evidence available from the transport.

## Add memory and per-session context

Pass per-session identifiers and metadata when starting a call:

```ts
const session = await agent.start({
  callHandle,
  channel: "web_audio",
  memoryUserId: user.id,
  organizationId: organization.id,
  workflowId: "appointment-intake",
  variables: { preferredLanguage: "en" },
  metadata: { source: "web" },
});
```

Configure memory on the agent and provide a memory adapter through runtime
options. User, organization, and workflow scopes can survive across calls.
Session scope is temporary by default and is purged during session finalization.
Read [persistence](./persistence.md) for adapters and retention behavior.

For tenant-specific prompts, the composable `defineAgent` API supports a
persona resolver. It can return an instruction override and string variables
from a CRM or tenant configuration service. The application remains the source
of truth for that data.

## Stop cleanly

Call `agent.stop()` during process shutdown:

```ts
const shutdown = async () => {
  await agent.stop();
};

process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
```

Stopping is idempotent. TVIC cancels active sessions, drains cleanup work, and
closes runtime-owned stores. If a cleanup operation fails or remains pending,
`healthCheck()` reports a degraded result.

## Move to the composable API

Use the composable surface when you need to own the orchestration boundary:

```ts
import { createRuntime, defineAgent, defineTool } from "voice-runtime";

const runtime = createRuntime({
  memory,
  durableStore,
  healthCheck: async () => ({ ok: true, checks: { database: { ok: true } } }),
});

const agent = defineAgent({
  id: "custom-agent",
  name: "Custom Agent",
  instructions: "You are a helpful assistant.",
  tools: [tool],
  providers: { telephony, stt, llm, tts },
  audioPolicy: { input: PCM16_16K_MONO, output: PCM16_16K_MONO },
});
```

The composable API exposes sessions, turns, memory, tools, the media plane,
standalone STT sessions, recovery helpers, and pipeline builders. It is more
flexible and requires more application lifecycle code. The complete list is in
the [API reference](./api-reference.md).
