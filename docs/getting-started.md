# Beginner's guide

This guide explains the smallest useful mental model for `voice-runtime` and
gets you from installation to a working voice-agent process.

The package is a server-side Node.js SDK. It coordinates an authenticated media
connection, speech recognition, a language model, tools, speech synthesis, and
the session lifecycle. Your application still owns the HTTP server, user
authentication, provider accounts, secrets, and business actions.

## What you will build

The agent in this guide has one job:

> You are a scheduling assistant for a doctor Collect the caller's name,
> preferred time, and reason for the visit. Confirm the details before booking.

The prompt controls the conversation. The transport supplies the caller's
audio, and the providers supply transcription, reasoning, and speech.

## Requirements

- Node.js 22, 24, or 26
- An application directory
- Provider credentials for a live call
- A browser audio or Twilio transport for a real conversation

The package supports both ESM and CommonJS imports. It runs on the server. A
browser connects to your server over the transport protocol; browser code does
not import `voice-runtime` directly.

## Choose your first path

| Goal                                    | Path                                                           | Credentials                          |
| --------------------------------------- | -------------------------------------------------------------- | ------------------------------------ |
| Prove the complete flow locally         | [Browser voice-mode example](../examples/voice-mode/README.md) | None in mock mode                    |
| Run a browser agent with real providers | [Browser voice-mode example](../examples/voice-mode/README.md) | Deepgram, Groq, and Cartesia         |
| Receive a phone call                    | [Twilio example](../examples/live-call/README.md)              | Twilio, Deepgram, Groq, and Cartesia |
| Build your own gateway                  | [Transport guide](./transports.md)                             | Your transport and provider accounts |

Start with mock mode if you are learning the lifecycle. Switch to live mode
after the gateway works without provider calls.

## Install the package

In a new application:

```bash
mkdir my-voice-agent
cd my-voice-agent
npm init -y
npm install voice-runtime
```

For CommonJS, use the same package from a `.cjs` file:

```js
const { createVoiceAgent } = require("voice-runtime");
```

For ESM, use an `.mjs` file or set `"type": "module"` in `package.json`:

```js
import { createVoiceAgent } from "voice-runtime";
```

## Run the credential-free example

The repository's browser example includes deterministic mock STT, LLM, and TTS
providers. It exercises the gateway, authentication flow, media protocol,
runtime, interruption handling, and playout acknowledgement without contacting
a paid service.

From a checkout of TVIC:

```bash
cp examples/voice-mode/.env.example .env
pnpm install --frozen-lockfile
pnpm --filter @tvic/example-voice-mode start
```

Open <http://localhost:8090>. In another terminal, mint a local development
token:

```bash
pnpm --silent --filter @tvic/example-voice-mode run mint-token -- demo-user
```

Paste the token into the page, allow microphone access, and connect. The mock
path is a local validation tool. It is not a production authentication system
and it does not prove that a paid provider account is configured correctly.

## Configure a live agent

The built-in managed API accepts provider configuration objects. Each provider
can also be supplied as a constructed provider instance. The following example
uses the reference live stack:

```js
import { createVoiceAgent, createWebClientAudioProvider } from "voice-runtime";

export function createAgent(telephony = createWebClientAudioProvider()) {
  return createVoiceAgent({
    id: "dr-kartik-scheduler",
    name: "Dr. Kartik Scheduler",
    prompt:
      "You are a scheduling assistant for a doctor Collect the caller's name, " +
      "preferred time, and reason for the visit. Confirm the details before booking.",
    providers: {
      telephony,
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
}
```

Set the credentials in the server environment before creating the agent:

```bash
export DEEPGRAM_API_KEY="..."
export GROQ_API_KEY="..."
export CARTESIA_API_KEY="..."
export CARTESIA_VOICE_ID="..."
```

Explicit `apiKey` values take precedence over environment variables. Missing
credentials and unsupported catalog models fail during agent construction or
before a live session starts.

## Connect a session

`createVoiceAgent()` configures the pipeline. It does not open a socket. A
verified transport must create a `CallHandle` and pass it to `start()`.

The built-in browser provider accepts a WebSocket after your gateway has
authenticated the user and created a call record:

```js
const telephony = createWebClientAudioProvider();
const agent = createAgent(telephony);

const session = await agent.start({
  call: verifiedCall,
  channel: "web_audio",
  callHandle: ({ sessionId, call }) => telephony.acceptWebSocket(socket, call.id, sessionId),
});
```

The call handle factory runs after TVIC creates the session. This lets the
transport stamp its events with the authoritative session ID. The complete
authentication, token, WebSocket, and browser protocol code is in the
[voice-mode example](../examples/voice-mode/README.md).

For an existing custom handle, pass it directly:

```js
const session = await agent.start({
  callHandle,
  channel: "simulated",
});
```

A `CallHandle` provides an async inbound event stream plus `send`, `clear`, and
`close` operations. It may also provide text delivery and playout confirmation.
Read the [transport guide](./transports.md) before implementing one.

## Observe events and await the result

The value at `session.run` has two uses. It is an async event stream and it is
awaitable for the final result.

```js
const eventsFinished = (async () => {
  for await (const event of session.run) {
    if (event.kind === "transcript_delta") {
      console.log("caller:", event.text);
    }
    if (event.kind === "tool_call") {
      console.log("tool:", event.toolName);
    }
    if (event.kind === "error") {
      console.error(event.error.code, event.error.message);
    }
  }
})();

try {
  const result = await session.run;
  await eventsFinished;
  console.log("turns:", result.turnsHandled);
  console.log("interruptions:", result.interruptions);
} finally {
  await agent.stop();
}
```

Consume the event stream once. Awaiting the same run more than once is safe, but
creating multiple async iterators for one run is rejected. The final result is
the authoritative terminal outcome. An event stream can contain a recoverable
error before the final result settles.

If you only need the final result, use `agent.run(options)`:

```js
const result = await agent.run({ callHandle, channel: "simulated" });
```

## Add a tool

Tools are application functions exposed to the language model. The application
must still authenticate the caller and enforce authorization inside the tool.

```js
import { createVoiceAgent, defineTool } from "voice-runtime";

const findAppointment = defineTool<
  { date: string },
  { date: string; times: string[] }
>({
  id: "find_appointment",
  name: "find_appointment",
  description: "Finds available appointment times for a requested date.",
  inputSchema: {
    type: "object",
    properties: { date: { type: "string" } },
    required: ["date"],
  },
  outputSchema: { type: "object" },
  async execute(input, context) {
    if (!context.tenant?.userId) {
      throw new Error("The caller identity is required");
    }
    return { date: input.date, times: ["09:00", "11:30"] };
  },
});

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

Use timeouts for external calls, make retries safe, and require a confirmation
before irreversible actions such as booking, payment, deletion, or cancellation.
See [tools and workflows](./tools-and-workflows.md).

## What TVIC owns

TVIC coordinates:

- Input and output media events
- Speech recognition streams
- Turn boundaries and endpointing
- Language-model output and tool calls
- Incremental speech synthesis
- Interruption and cancellation
- Provider capability checks
- Session, turn, and tool-call lifecycle
- Optional durable state and memory adapters

Your application owns:

- User authentication and authorization
- HTTP and WebSocket routing
- Phone numbers and Twilio account setup
- Browser permissions and client UI
- Provider accounts, API keys, and billing
- Business data and external actions
- Deployment, scaling, logs, and retention policy

## Next steps

- Read [Building a voice agent](./building-a-voice-agent.md) for the complete
  managed and composable API model.
- Read [Providers](./providers.md) before choosing models or voice IDs.
- Read [Transports](./transports.md) before accepting browser or phone traffic.
- Read [Testing](./testing.md) before using a live provider in production.
- Read [Security](./security.md) before exposing a public endpoint.
