# Start here

This page is for a developer who knows Node.js but has not worked with TVIC or
realtime voice systems before.

## TVIC in one sentence

TVIC runs the server-side conversation loop for a live voice session:

```text
audio connection → speech-to-text → language model and tools → text-to-speech → audio connection
```

It also handles the difficult timing around turns, interruptions, cancellation,
provider failures, and whether generated audio was actually played.

If terms such as STT, LLM, TTS, VAD, or `CallHandle` are new to you, use the
[TVIC glossary](./glossary.md). The short version is: STT reads speech, the LLM
chooses a response, and TTS speaks that response.

## What `npm install voice-runtime` gives you

The package gives your Node.js application:

- a prompt-first `createVoiceAgent` API;
- provider adapters and provider-neutral interfaces;
- browser-audio and inbound Twilio transport handles;
- turn, interruption, cancellation, and event handling;
- tools with validation, timeouts, abort signals, retries, and idempotency;
- in-memory, PostgreSQL, Redis, and composite persistence building blocks;
- ESM, CommonJS, and TypeScript package entry points.

Installing it does not, by itself:

- create an HTTP or WebSocket endpoint;
- create or answer a phone call;
- request browser microphone permission;
- create provider accounts or API keys;
- authenticate your users;
- authorize business actions;
- decide what your application is allowed to change.

Those boundaries stay with the host application so a prompt cannot silently
become an authorization system.

## The five concepts to know

1. **Agent:** reusable instructions, providers, tools, and runtime policies.
2. **Session:** one live conversation with one caller or browser user.
3. **Transport:** how audio enters and leaves, such as browser WebSocket audio or
   Twilio Media Streams.
4. **Provider:** an STT, LLM, TTS, or telephony implementation.
5. **Events:** the observable transcript, turn, tool, error, audio, and session
   lifecycle.

## Your first choice

### I want to see a working voice system locally

Use the browser voice-mode example. It runs with deterministic mock STT, LLM, and
TTS providers, so no paid account is needed:

```bash
cp examples/voice-mode/.env.example .env
pnpm install --frozen-lockfile
pnpm --filter @tvic/example-voice-mode start
```

In another terminal, mint a local development token:

```bash
pnpm --silent --filter @tvic/example-voice-mode run mint-token -- demo-user
```

Open <http://localhost:8090>, paste the token, allow microphone access, and press
Connect. Read the [browser example guide](../examples/voice-mode/README.md) for
the wire protocol and live-provider mode.

### I want an inbound phone agent

Use the [Twilio example](../examples/live-call/README.md). You will need a public
HTTPS URL or tunnel, a Twilio Voice webhook, signed media-stream tokens, and
credentials for the selected STT, LLM, and TTS providers.

The package does not create the Twilio call or expose an unauthenticated webhook.
The host application verifies the webhook, then hands the authenticated media
connection to TVIC.

### I want to control the pipeline myself

Use the composable root exports. You can keep TVIC's session and turn machinery
while supplying your own STT, LLM, TTS, telephony, memory, or durable store. The
provider contracts are documented in the package README and exported from the
package root.

## A managed agent, conceptually

The managed API removes most pipeline assembly:

```ts
import { createVoiceAgent } from "voice-runtime";

const agent = createVoiceAgent({
  prompt: "You schedule appointments. Confirm the date and time before booking.",
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
```

This creates the agent configuration. A live session still needs an authenticated
`CallHandle` from your browser or phone transport:

```ts
const session = await agent.start({
  callHandle,
  channel: "web_audio",
});

for await (const event of session.run) {
  if (event.kind === "transcript_delta") console.log(event.text);
  if (event.kind === "error") console.error(event.error);
}

const result = await session.run;
await agent.stop();
```

The run is both an async event stream and an awaitable final result. This lets an
application observe the call live and still receive a final summary.

## What happens during a call

1. Your application authenticates a browser or phone connection.
2. The transport produces normalized input media for TVIC.
3. STT emits partial and final transcript information.
4. TVIC decides when the caller's turn is complete.
5. The LLM may produce text and validated tool calls.
6. TVIC executes tools with cancellation and timeout boundaries.
7. TTS produces output audio, possibly incrementally.
8. TVIC sends audio and waits for the transport's playout signal when available.
9. A caller interruption cancels the active response and clears queued output.
10. The session ends with a result and a `call_ended` event.

## What your application still owns

| Concern                                          | Owner                                      |
| ------------------------------------------------ | ------------------------------------------ |
| Provider credentials                             | Your server and secret manager             |
| User authentication and authorization            | Your application                           |
| HTTP/webhook lifecycle                           | Your application and transport integration |
| Calendar, CRM, payments, or case state           | Your application tools/workflows           |
| Confirmation for irreversible actions            | Your application policy                    |
| Recordings, traces, dashboards, retention policy | Your observability/compliance system       |

The prompt describes behavior. Tools and application policy decide what the agent
may actually do.

## Continue from here

- [Providers, models, and API keys](./providers.md)
- [TVIC skills for AI coding agents](./agent-skills.md)
- [How the runtime works](./how-it-works.md)
- [Browser voice-mode example](../examples/voice-mode/README.md)
- [Inbound Twilio example](../examples/live-call/README.md)
- [Composable API](../packages/voice-runtime/README.md#composable-api)
- [Security and production boundaries](./security.md)
