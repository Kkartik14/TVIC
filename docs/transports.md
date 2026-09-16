# Transports

A transport connects a caller to the runtime. It is responsible for accepting
the connection, authenticating it, converting vendor wire messages into TVIC
media events, and delivering TVIC output back to the caller.

The public package is server-side only. Browser code and phone networks connect
to a server that uses `voice-runtime`.

## The transport boundary

TVIC receives a `CallHandle` with this shape:

```ts
interface CallHandle {
  readonly callId: string;
  readonly events: AsyncIterable<InboundMediaEvent>;
  send(event: OutputMediaEvent): Promise<boolean>;
  clear(): Promise<void>;
  close(reason: StreamEndReason): Promise<void>;
  deliverText?(turnId: string, sequence: number, text: string): Promise<boolean>;
  confirmPlayout?(markId: string, timeoutMs: number): Promise<boolean>;
}
```

The handle has important delivery semantics:

- `send()` returning `true` means the frame reached the transport boundary. It
  does not necessarily mean the caller heard it.
- `clear()` removes queued output when the transport supports it.
- `confirmPlayout()` reports whether marked output was actually played. It is
  optional because some transports cannot observe the caller's speaker.
- `close()` ends the transport and closes its inbound event stream.

The handle's `callId` must match the `Call` passed to a managed session.

## Session startup order

Use this order for a live connection:

1. Authenticate the user, webhook, or signed transport token.
2. Validate origin, request size, rate limits, and session limits.
3. Create a complete `Call` record.
4. Start TVIC with a call-handle factory.
5. Accept the already-authenticated socket after TVIC gives the factory a
   session ID.
6. Consume the event stream once and await the final result.
7. Close the handle and release application resources.

The factory form keeps the call, transport, and runtime session identities tied
together:

```ts
const session = await agent.start({
  call: verifiedCall,
  channel: "web_audio",
  callHandle: ({ sessionId, call }) => webAudio.acceptWebSocket(socket, call.id, sessionId),
});
```

Do not accept an unauthenticated socket and rely on the prompt or provider to
protect it. Authorization belongs before the handle reaches the runtime.

## Web Client Audio

The Web Client Audio adapter is the stable browser transport. It uses a Node
WebSocket server and a browser client protocol. The browser sends PCM audio and
control messages. The server sends PCM output audio and lifecycle messages.

Create the provider on the server:

```ts
import { createWebClientAudioProvider } from "voice-runtime";

const webAudio = createWebClientAudioProvider({
  maxSessionDurationMs: 45 * 60 * 1000,
});
```

When a verified socket is ready:

```ts
const session = await agent.start({
  call: verifiedCall,
  channel: "web_audio",
  callHandle: ({ sessionId, call }) =>
    webAudio.acceptWebSocket(socket, call.id, sessionId, {
      expectedMode: "push_to_talk",
    }),
});
```

The repository's [voice-mode example](../examples/voice-mode/README.md) shows
the complete gateway. Its local protocol uses:

- PCM16 little-endian, 16 kHz, mono audio
- A versioned binary frame header
- A short-lived, single-use session token
- Origin checks and bearer authentication
- Push-to-talk and continuous modes
- Heartbeats and hard session limits
- Output commit messages followed by playout acknowledgements

The example's local HMAC token is a development helper. Use your application's
identity provider and a shared session store for production.

### Browser security checklist

- Keep provider keys, token-signing secrets, and admin secrets on the server.
- Require an allowed origin for token minting and WebSocket upgrades.
- Authenticate the application user before minting a media token.
- Make tokens short-lived and single-use.
- Bind the token to the user and session reference.
- Limit body size, token mint rate, session duration, and concurrent sessions.
- Use HTTPS and secure WebSockets outside local development.
- Do not trust metadata sent by the browser.

## Inbound Twilio Media Streams

The Twilio adapter is an accept-only bridge. The host application owns the
phone number, TwiML webhook, Twilio signature verification, and public HTTPS
endpoint.

Create the provider:

```ts
import { createTwilioMediaStreamsProvider } from "voice-runtime";

const twilio = createTwilioMediaStreamsProvider();
```

After the webhook and media WebSocket are authenticated:

```ts
const session = await agent.start({
  call: verifiedCall,
  channel: "phone",
  metadata: {
    twilioCallSid,
    accountSid,
  },
  callHandle: ({ sessionId, call }) => twilio.acceptWebSocket(socket, call.id, sessionId),
});
```

The adapter converts Twilio's 8 kHz mu-law edge format to TVIC's normalized
16 kHz PCM16 format and converts output back for Twilio. It handles media
sequence validation, DTMF, buffer clear, marks, and playout acknowledgement.

The [live-call example](../examples/live-call/README.md) includes the gateway,
replay protection, signed stream tokens, and production configuration.

### Twilio security checklist

- Verify the Twilio webhook signature before parsing or acting on the request.
- Bind the authenticated call identity to the media stream `start` message.
- Use short-lived, single-use stream tokens.
- Reject identity mismatches and duplicate webhook deliveries.
- Use Redis or another shared store for replay protection across replicas.
- Use sticky WebSocket routing or a shared stream-token store when scaling the
  example horizontally.
- Keep `ALLOW_UNAUTHENTICATED_TWIML=false` in production.
- Set `TWILIO_AUTH_TOKEN` and `STREAM_TOKEN_SECRET` in production.

## Custom transports

Implement a custom transport when your media source is not browser WebSocket or
Twilio. The adapter must translate the source protocol into TVIC's typed media
events and implement the output semantics honestly.

At minimum, a custom handle must provide:

```ts
const callHandle = {
  callId,
  events: inboundEvents,
  async send(event) {
    return writeToYourTransport(event);
  },
  async clear() {
    await clearYourQueuedAudio();
  },
  async close(reason) {
    await closeYourConnection(reason);
  },
};
```

If the transport cannot prove playout, omit `confirmPlayout()` rather than
returning a guessed success. If it cannot clear queued audio, declare that
limitation in its provider capabilities and test interruption behavior around
it.

The runtime expects normalized audio and ordered events. Preserve a source
sequence or timestamp when the protocol provides one. Reject malformed frames,
oversized messages, invalid audio formats, and identity mismatches at the
transport boundary.

## Transport shutdown

When the socket closes:

1. Stop accepting input.
2. Close the inbound event stream.
3. Let the runtime finalize the current turn and session.
4. Await the final result or handle its normalized error.
5. Release tokens, maps, leases, and external resources.

During process shutdown, stop accepting new connections before calling
`agent.stop()`. The managed agent cancels active sessions and drains runtime
cleanup. Read [Deploying](./deploying.md) for signal handling and readiness.
