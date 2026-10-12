# Use TVIC from Python

TVIC keeps one canonical voice runtime in the open-source TypeScript SDK. A
consumer can run its optional Node worker and call it from Python or another
language through a documented, versioned WebSocket protocol. The worker is
consumer-hosted and uses the same managed runtime and provider adapters as a
normal Node application.

The Python client is a source-installable preview in this repository; it has not
been published to PyPI. Install it from the repository root with
`python -m pip install ./sdks/python`. The npm release process publishes only
the Node.js package.

In this preview, agent definitions and provider configuration stay in the
consumer's Node process. Python starts a named agent, streams PCM audio, receives
events/audio, and runs application tool handlers. The worker does not create a
TVIC account API, agent control plane, secret store, or authentication system.
The consumer chooses how to expose it and whether to integrate access or
identity checks; TVIC does not prescribe a network boundary.

If `host` is omitted, the worker uses Node's normal `server.listen(port)`
behavior for an unspecified address, which listens on the available network
interfaces. Set `host` if this application needs a specific bind address. TVIC
does not default the worker to loopback or require a separate ingress layer.

## Configure the Node worker

Install `voice-runtime` in the consumer's Node service and register the agents
that Python clients may start:

```ts
import { createRemoteVoiceService, createVoiceAgent } from "voice-runtime";

const service = createRemoteVoiceService({
  // Omit `host` to use Node's unspecified-address bind, or set it for this app.
  port: 8090,
  agents: [
    {
      id: "appointments",
      tools: [
        {
          id: "lookup_customer",
          name: "lookup_customer",
          description: "Looks up a customer by email.",
          inputSchema: {
            type: "object",
            required: ["email"],
            properties: { email: { type: "string" } },
          },
          outputSchema: {
            type: "object",
            required: ["found"],
            properties: { found: { type: "boolean" } },
          },
        },
      ],
      createAgent({ telephony, tools }) {
        return createVoiceAgent({
          id: "appointments",
          prompt: "Help callers schedule appointments.",
          providers: {
            telephony,
            stt: { provider: "deepgram", apiKey: process.env.DEEPGRAM_API_KEY },
            llm: { provider: "groq", apiKey: process.env.GROQ_API_KEY },
            tts: {
              provider: "cartesia",
              apiKey: process.env.CARTESIA_API_KEY,
              voiceId: process.env.CARTESIA_VOICE_ID,
            },
          },
          tools,
        });
      },
    },
  ],
  // Optional: implement the consumer application's own authorization here.
  // authorizeConnection(request, url, agentId) { ... },
});

await service.start();
```

The worker serves `/v1/agents/<agent-id>` and `/healthz`. Its
`authorizeConnection` option is optional and only provides a hook for
consumer-owned policy. Omitting it leaves the route available to connections
that can reach the worker. TVIC does not prescribe how the consumer exposes the
worker or ship an auth provider, token format, user database, or role system. If
the hook returns `memoryUserId`, `organizationId`, or `workflowId`, TVIC passes
those values to the runtime and Python tool call context.

Provider credentials remain in the consumer's Node process. Use the existing
`createVoiceAgent` API to configure models, runtime policies, and providers.
The `telephony` and `tools` arguments supplied to `createAgent` are the worker's
WebSocket media adapter and Python-dispatched tool callbacks; include both in
the returned agent.

Each registered `createVoiceAgent()` owns its runtime by default. If multiple
agents share a durable store or database pool, set
`runtime.durableStoreOwnership` to `"caller"` on each agent and close the shared
store after stopping the worker. Otherwise, stopping one agent may close a
store that another registered agent still uses.

## Connect from Python

Install the Python client from the repository root:

```sh
python -m pip install ./sdks/python
```

Connect with a handler for each tool declared on the Node agent. Tool handlers
receive validated JSON input and `RemoteToolContext`, including a stable
idempotency key and any tenant identity returned by the application's auth
hook:

```python
from tvic import RemoteToolContext, RemoteVoiceClient


async def lookup_customer(inputs, context: RemoteToolContext):
    return await customer_service.lookup(inputs["email"])


client = RemoteVoiceClient(
    "wss://voice.example.com",
    headers={"Authorization": "Bearer <application-issued-token>"},
)

async with await client.connect(
    "appointments",
    tools={"lookup_customer": lookup_customer},
    mode="push_to_talk",
) as session:
    await session.send_audio(pcm16_frame)
    await session.end_turn()

    async for event in session.events():
        if event.kind == "audio_output":
            await audio_player.write(event.payload["audio"])
        elif event.kind == "output_commit":
            await session.acknowledge_playout(event.payload["commitId"])
        elif event.kind == "transcript_delta":
            print(event.payload["text"])
```

Audio methods accept PCM16 little-endian 16 kHz mono frames. If `offset_ms` is
omitted, Python derives each frame's start offset from successfully sent
samples; explicit offsets must not move backwards. The client does not capture
a microphone or play audio; the Python application supplies those edges. A tool
handler can be a synchronous or asynchronous callable. The client
bounds concurrent tool calls per session; exceeding that limit closes the
session with `RemoteVoiceError(code="tool_capacity")` and cancels active local
handlers. Synchronous handlers also run in a bounded process-wide worker pool.
Cancelling a call cannot stop a handler that is already running in a thread or
reverse an external side effect; new synchronous calls receive a tool error
while the process-wide pool is full. Async handlers are limited per session;
the application controls their aggregate concurrency through session admission
and handler design.

Read [remote runtime protocol v1](./protocols/remote-runtime-v1.md) for frame,
event, cancellation, and lifecycle details. This protocol is the starting point
for future language clients; clients should depend on the versioned contract,
not internal TypeScript module paths.
