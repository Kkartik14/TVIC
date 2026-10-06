# Transports

A transport connects a caller to the runtime. It is responsible for accepting
the connection, authenticating it, converting vendor wire messages into TVIC
media events, and delivering TVIC output back to the caller.

The public package is server-side only. Browser code and phone networks connect
to a server that uses `voice-runtime`.

**Release status:** the lifecycle and authorization additions described below
are available in this checkout but are not yet included in published
`voice-runtime@1.2.0`. See the [API reference release note](./api-reference.md#release-status-checked-2026-09-30)
and check the installed package declarations before using them from npm.

## The transport boundary

TVIC receives a `CallHandle` with this shape:

```ts
interface CallHandle {
  readonly callId: string;
  readonly events: AsyncIterable<InboundMediaEvent>;
  /** Resolves on remote hangup or peer loss, but not host-initiated close. */
  readonly remoteHangup?: Promise<void>;
  send(event: OutputMediaEvent): Promise<boolean>;
  clear(): Promise<void>;
  /** Ends inbound media while keeping outbound delivery available. */
  endInput?(reason: StreamEndReason): Promise<void>;
  close(reason: StreamEndReason): Promise<void>;
  deliverText?(turnId: string, sequence: number, text: string): Promise<boolean>;
  confirmPlayout?(markId: string, timeoutMs: number): Promise<boolean>;
}
```

The handle has important delivery semantics:

- `send()` returning `true` means the frame reached the transport boundary. It
  does not necessarily mean the caller heard it.
- `clear()` removes queued output when the transport supports it.
- `endInput()` half-closes inbound media while leaving output delivery active.
  It is optional for transports that cannot half-close.
- `remoteHangup` resolves when the remote peer hangs up or the transport drops,
  including after input has ended. It is optional when a transport cannot
  distinguish remote loss from host closure.
- `confirmPlayout()` reports whether marked output was actually played. It is
  optional because some transports cannot observe the caller's speaker.
- `close()` ends the transport, including outbound delivery, and closes its
  inbound event stream.

The handle's `callId` must match the `Call` passed to a managed session.
For a managed call, use `session.complete()` to end input and wait for runtime
arbitration, persisted finalization, and transport close. It requires
`endInput()` support; the `endInput()` operation is bounded to five seconds. A
timed out or rejected `endInput()` aborts the run and persists a timeout or
provider failure.
Use `session.stop()` for an operator cancellation. These controls keep
transport closure aligned with the final runtime outcome. A remote hangup is
tracked separately through `remoteHangup` when supported.
`CallHandle.close(reason)` is the low-level transport operation; calling it
directly can stop output before the runtime has resolved the final call state.

`NodeMediaPlane.authorizeUpgrade` runs before the WebSocket handshake and may be
synchronous or asynchronous. It receives an `AbortSignal`, defaults to a
250 ms deadline, and is concurrency-bounded; configure
`authorizationTimeoutMs` and `maxPendingAuthorizations` for the host's auth
store. Return only a small verified context. If an accepted handshake aborts,
`onUpgradeAborted` can release a token reservation. These are generic transport
hooks: the host owns token format, signature/expiry checks, origin policy,
single-use enforcement, and shared replay storage.
The release hook runs best-effort and is not awaited; failures are passed to
`onUpgradeAbortedError`. There is no default logging; provide that reporter when
the host needs visibility. An asynchronous restore can overlap an immediate
retry, so hosts with asynchronous reservation stores should guard ownership
atomically and make authorization wait for restoration or return a transient
busy result that the client can retry. Atomic ownership checks prevent a stale
restore from releasing a newer reservation, but do not make an early retry
succeed. Errors from the reporting hook are swallowed.
The deadline rejects the upgrade; it cannot forcibly cancel the host's async
check. Honor the signal. An unsettled check continues to occupy a concurrency
slot until it settles, so an unresponsive auth dependency fails closed at the
configured cap. If a check returns a reservation after timeout or disconnect,
`onUpgradeAborted` is called best-effort to release it. During
`NodeMediaPlane.stop()`, new upgrades are rejected and pending upgrade sockets
are destroyed, which aborts their signals so shutdown does not wait for the
authorization deadline. A late successful authorization is not upgraded and
its reservation is passed to `onUpgradeAborted` once. A host authorization
check that ignores abort can continue occupying a concurrency slot until it
settles; the plane cannot cancel arbitrary host work.

Shutdown also closes HTTP admission immediately. `onRequest` and `healthCheck`
receive an `AbortSignal` that is aborted when their client disconnects or the
plane starts stopping. Active HTTP sockets are closed so a pending host callback
cannot hold `stop()` open. A callback that ignores its signal may continue its
own work after the response socket closes; bound that work and check the signal
before starting side effects. Requests dispatched after shutdown begins receive
503 if their socket is still writable. Connections arriving as the listener is
closing may instead be refused or reset. No new request reaches a host callback
after shutdown begins. An abort cannot undo a host side effect that has already
started; callbacks should check the signal before starting irreversible work.
Hosts that need to recover a committed operation after a lost response must
provide their own idempotency and result-retrieval policy.

Connected WebSocket peers receive a close frame. `webSocketCloseTimeoutMs`
controls how long the plane waits for each closing handshake before `ws`
terminates an unresponsive peer; it defaults to 5000 ms and accepts values
from 1 through 60000 ms.

## Session startup order

Use this order for a live connection:

1. Authenticate the user, webhook, or signed transport token.
2. Validate origin, request size, rate limits, and session limits.
3. Create a complete `Call` record.
4. Start TVIC with a call-handle factory.
5. Accept the already-authenticated socket after TVIC gives the factory a
   session ID.
6. Consume `session.run` once; run the event consumer concurrently with session
   lifecycle controls.
7. When the host flow succeeds, call `session.complete()` to half-close input
   and await persisted finalization. Call `session.stop()` for an operator
   cancellation. Then join any event consumer and release application
   resources. The managed session closes the transport with the persisted
   outcome.

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

`maxSessionDurationMs` must be a positive integer no greater than 2,147,483,647
milliseconds, the maximum delay accepted by Node timers. The provider validates
this value at construction and uses the resolved value for both the advertised
session limit and its timer.

The adapter defaults to 65,536 bytes per binary message and 4,096 bytes per
control message. It also limits audio input to 128,000 bytes and 200 frames per
second, and control input to 16,384 bytes and 50 messages per second. These
limits use rolling two-second windows. Host-configured input ceilings are
bounded to 1,000,000 bytes per second and 1,000 frames per second; the pending
event queue is capped at 2,048 entries. A binary-frame cap must allow at least
14 bytes for the 12-byte header and one PCM16 sample; its effective value is
capped at 1 MiB. The rate checks run after the WebSocket
implementation has assembled a complete message, so set the server's
parser-level payload and fragment limits before accepting connections. A
fragment limit bounds parser work for messages split across many frames,
including empty fragments. For a custom `ws` server using the default adapter
limit:

```ts
import { WebSocketServer } from "ws";
import { WEB_CLIENT_AUDIO_DEFAULTS } from "voice-runtime";

const webSocketServerOptions: ConstructorParameters<typeof WebSocketServer>[0] & {
  readonly maxFragments: number;
  readonly autoPong: boolean;
} = {
  noServer: true,
  maxPayload: Math.max(4_096, WEB_CLIENT_AUDIO_DEFAULTS.maxBinaryFrameBytes),
  maxFragments: 128,
  autoPong: false,
};
const webSocketServer = new WebSocketServer(webSocketServerOptions);
```

If `maxBinaryFrameBytes` is configured, use its effective value after the
adapter's 1 MiB hard cap in this calculation. `NodeMediaPlane` has its own
finite `maxInboundFrameBytes` parser cap, defaulting to 1 MiB and accepting
values from 1 byte through 16 MiB; configure it to the same message limit when
the stricter Web Client Audio limit should apply before message assembly. The
16 MiB ceiling keeps the configured value within the parser's supported range
and bounds per-message allocation. Its `maxInboundFrameFragments` defaults to
128 and must be between 1 and 16,384; custom `ws` servers should also set a
finite `maxFragments` value. `NodeMediaPlane` accepts at most 10 WebSocket Ping
and Pong control frames combined per peer in any rolling one-second window,
replies to allowed Pings, and closes peers that exceed the limit with code 1008.
For custom `ws` servers, disable `autoPong`, enforce the same combined
10-frames-per-second limit on both `ping` and `pong` events, and call
`socket.pong(payload)` only for allowed Pings. The default `autoPong` replies
before the `ping` event, so the server cannot apply a rate limit there while it
is enabled.

Heartbeat settings are validated at provider construction: the interval must
be 100–60,000 ms, and the timeout must be 200–120,000 ms and greater than the
interval. The bundled browser client sends `client.ping` at the advertised
interval; custom clients should use that cadence so each ping can refresh idle
activity. Defaults are 5,000 ms and 10,000 ms.

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

The bundled `NodeMediaPlane` applies both parser-level limits:
`maxInboundFrameBytes` defaults to 1 MiB and accepts values up to 16 MiB, while
`maxInboundFrameFragments` defaults to 128. Set the byte limit to the adapter's effective binary limit
(at least 4,096 bytes for control messages) when you need the stricter adapter
limit before message assembly.

### Browser security checklist

- Keep provider keys, token-signing secrets, and admin secrets on the server.
- Require an allowed origin for token minting and WebSocket upgrades.
- Authenticate the application user before minting a media token.
- Make tokens short-lived and single-use.
- Bind the token to the user and session reference.
- Bind a call capability to one opaque call ID, agent, audience, expiry, and
  nonce; consume it atomically before accepting the socket.
- Limit body size, token mint rate, session duration, and concurrent sessions.
- Set the WebSocket parser payload limit to the adapter's effective message
  limit and set a finite fragment-count limit before accepting connections;
  the adapter's own checks run after message assembly.
- Disable WebSocket automatic Pong replies and rate-limit Ping and Pong control
  frames per peer before replying to Pings.
- Use HTTPS and secure WebSockets outside local development.
- Do not trust metadata sent by the browser.
- Redact any token carried in the WebSocket URL from all access logs.

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
Sequenced messages must start at `1` and increment by one; the unsequenced
`connected` message does not advance that counter. Outbound audio events must
use mono PCM16 at 16 kHz. A commit flushes its final partial audio frame before
the mark, while `clear()` drops locally buffered partial audio and sends a clear
barrier before later output.

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
