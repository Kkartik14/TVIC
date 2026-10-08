# TVIC browser voice mode

This example is an executable browser client and authenticated gateway. It runs as a
separate deployable from `examples/live-call` so browser traffic cannot consume the
phone gateway's capacity.

## Local demo (no provider accounts)

From the repository root:

```bash
cp examples/voice-mode/.env.example .env
pnpm install --frozen-lockfile
pnpm --filter @tvic/example-voice-mode start
```

Open <http://localhost:8090>, generate a local application token in another terminal,
and paste it into the client:

```bash
pnpm --silent --filter @tvic/example-voice-mode run mint-token -- demo-user
```

Allow microphone access, choose push-to-talk or continuous mode, and press Connect.
In push-to-talk mode, hold the button, Space, or Enter to speak; releasing the key
or button ends the turn.
The mock STT, LLM, and TTS providers make the complete gateway → runtime → browser
loop executable without credentials. Push-to-talk mock turns settle on each explicit
turn boundary; continuous mode uses deterministic 500 ms audio windows instead of
real VAD. This mode is for local validation only.

The client first mints a single-use session token with `POST /v1/voice/session`, then
opens `/voice/:sessionRef?token=...&exp=...` and sends `session.start`. The mint request
requires the application bearer token and this JSON body. Browser requests must send
an `Origin` listed in `ALLOWED_ORIGINS`; non-browser callers may omit `Origin`, but any
supplied value must be allowlisted:

```json
{ "mode": "push_to_talk" }
```

The response is `201` with `{ sessionRef, token, expMs, mode }`. Treat `token` as
short-lived bearer material. Browser clients must not receive any gateway signing
secret.

Mint errors use a JSON `{ error }` body when the response reaches the client;
`429 rate_limited` also includes `closeCode: 4429`. If a streamed request crosses the
body-size limit, the gateway also destroys that request connection after detecting it.

| Status | Error codes                                                                                    |
| ------ | ---------------------------------------------------------------------------------------------- |
| `400`  | `invalid_json`, `invalid_mode`, `invalid_supersedes`                                           |
| `401`  | `unauthorized`                                                                                 |
| `403`  | `origin_rejected`, `invalid_supersedes`                                                        |
| `405`  | `method_not_allowed`                                                                           |
| `409`  | `cap_exceeded`                                                                                 |
| `413`  | `payload_too_large`                                                                            |
| `415`  | `unsupported_media_type`                                                                       |
| `429`  | `rate_limited`                                                                                 |
| `503`  | `mint_capacity_reached`, `session_store_capacity`, `supersede_unavailable`, `supersede_failed` |

An allowed-origin `OPTIONS` preflight (or one without `Origin`) returns `204`; a
disallowed origin returns `403 origin_rejected`. The client UI keeps the last minted session reference across
reconnect attempts. If that reference is no longer valid, it retries the mint once
without `supersedes`; an active prior slot can still produce `409 cap_exceeded`.
When present, `supersedes` must be a non-empty string; malformed values return
`400 invalid_supersedes`, while unknown or unowned string references return
`403 invalid_supersedes`.

## Wire protocol

All audio is PCM16 little-endian, 16 kHz mono. Client binary frames contain a 12-byte
little-endian header followed by an even number of payload bytes:

| Bytes | Meaning                                           |
| ----- | ------------------------------------------------- |
| 0     | protocol version, currently `1`                   |
| 1     | flags, currently `0`                              |
| 2–5   | contiguous client audio sequence, starting at `1` |
| 6–9   | monotonic input offset in milliseconds            |
| 10–11 | reserved, must be `0`                             |
| 12+   | PCM16 payload                                     |

The first client control message is:

```json
{
  "type": "session.start",
  "protocolVersion": 1,
  "mode": "push_to_talk",
  "clientPlatform": "your-app",
  "audioFormat": { "encoding": "pcm_s16le", "sampleRateHz": 16000, "channels": 1 }
}
```

The server replies with `session.ready`, including `heartbeatIntervalMs` and
`maxSessionDurationMs`. The bundled client sends `client.ping` at the advertised
heartbeat interval. Custom clients should use the same cadence; the server only
counts pings received at least one interval apart toward idle activity.
`turn.end` commits a push-to-talk turn; `client.interrupt` requests an explicit
interruption; `session.end` closes the session.

Server binary frames use the same header shape, with the sequence referring to output
audio. Server JSON includes `assistant.text`, `output.clear`, `output.commit`,
`session.error`, and `session.ended`. After all output frames in an `output.commit`
`sequenceRange` have actually played, the client must send:

```json
{ "type": "output.playout_ack", "commitId": "..." }
```

Do not acknowledge on socket receipt; the runtime uses this signal as transport
playout evidence.

`TvicVoiceClient` emits these browser events. Their callback receives a `CustomEvent`,
and the payload is available as `event.detail`:

| Event              | Detail                                                                     |
| ------------------ | -------------------------------------------------------------------------- |
| `connected`        | `{ sessionRef, expMs, mode }`; the bearer token is intentionally omitted.  |
| `ready`            | The `session.ready` message, including session/call IDs and timing limits. |
| `transmitting`     | `true` while sending microphone audio; `false` when the turn ends.         |
| `assistant-text`   | The `assistant.text` message with `turnId`, `sequence`, and `text`.        |
| `audio`            | `{ sequence, durationMs }` for a decoded output frame.                     |
| `pong`             | The `server.pong` message.                                                 |
| `error`            | An `Error` with a stable `message` and optional machine-readable `code`.   |
| `ended`            | `{ type: "session.ended", reason }` for the remote terminal outcome.       |
| `transport-closed` | The browser `CloseEvent` from the WebSocket.                               |
| `closed`           | `undefined`; local client resources have been released.                    |

`ended` may be followed by `closed`. The client preserves the terminal reason in
`lastEndReason` and the latest emitted error in `lastError` after cleanup. The demo keeps
protocol failure details visible after the socket closes. A plain disconnect without a
terminal outcome or error leaves those properties `undefined`. The adjacent
`voice-client.d.ts` declares these event names and payloads for TypeScript consumers.

Browser setup failures from `connect()` (such as microphone permission, session mint, or
WebSocket establishment failures) reject the `connect()` promise. Catch that promise;
these setup failures do not emit the `error` event or populate `lastError`. The `error`
event is for failures received after the session transport has started.
Calling `close()` during setup rejects the pending `connect()` promise, aborts the session
mint request, closes a WebSocket that has not opened yet, and stops microphone tracks if
the browser grants permission after cancellation.

## Live provider mode

Set `VOICE_PROVIDER_MODE=live` and configure Groq Chat Completions with
`VOICE_LLM_PROVIDER=groq`, `GROQ_API_KEY`, and optionally
`GROQ_MODEL=openai/gpt-oss-20b`.

- `ALLOWED_ORIGINS`, `VOICE_AUTH_SECRET`, `VOICE_ADMIN_SECRET`;
- `STREAM_TOKEN_SECRET`, `SAFETY_IDENTIFIER_SECRET`;
- `DEEPGRAM_API_KEY` and `GROQ_API_KEY`;
- `CARTESIA_API_KEY` and `CARTESIA_VOICE_ID` for the required live audio output.

Useful bounds are configurable with `STREAM_TOKEN_TTL_MS`,
`MAX_SESSION_DURATION_MS`, `CONCURRENT_SESSION_CAP`, and
`MINT_RATE_LIMIT_PER_MINUTE`. The concurrent-session default is one. When a prior
session slot may still be active, reconnect with
`await client.connect({ supersedes: priorSessionRef })`; `client.lastSessionRef` exposes
the last minted reference even when the WebSocket did not open. The gateway only accepts
a reference owned by the same authenticated user. Omit `supersedes` for a fresh session
after the previous slot has been released. The browser example retries once without a
reference when the gateway returns `403 invalid_supersedes`. Clients ping every five
seconds; the server closes after ten seconds with neither a ping nor audio. The hard
session-duration default is 45 minutes.

The example keeps mint-limit state and unconsumed session reservations in process
memory. It caps each map at 10,000 users or sessions and returns `503` if a global
bound is reached. Mint requests inspect only the current user's session slots and do
bounded cleanup of expired entries. These limits are per process; multiple gateway
instances need a shared session store and a host-owned distributed rate limiter.

With PostgreSQL configured, local and standalone runs bootstrap the runtime and
memory schemas before opening request-time pools. When `NODE_ENV=production` or
`TVIC_ENV=production`, the app skips database migrations at startup. Run both
`runPostgresMigrations` and `runPostgresMemoryMigrations` from a deployment job
before starting the app, using migration credentials separate from the runtime
database credentials where possible.

`409 cap_exceeded` means a per-user session slot is still reserved. If the browser knows
that session reference, pass it as `supersedes`. A lost mint response can leave the
browser without the new reference; the gateway has no idempotency key or result lookup,
so that slot remains unavailable until `STREAM_TOKEN_TTL_MS` expires (120 seconds by
default) or the host terminates it. A supersede request can close the old session before
its response reaches the browser; a retry cannot recover the replacement token. This
example does not define a product-level idempotency window.

If a request is cancelled before the gateway starts superseding the prior session, its
reservation is restored. If cancellation is detected after superseding starts, the
gateway releases an undelivered replacement slot where possible. Network loss after an
HTTP response has been sent may be undetectable by the server.

Run with `pnpm --filter @tvic/example-voice-mode start`. The listener binds to
`127.0.0.1` by default through `VOICE_GATEWAY_HOST`. For a proxy in a separate container,
bind to a private interface and restrict the gateway port with the deployment network
policy; use `0.0.0.0` only when that network policy blocks direct public access. In
production, use HTTPS/WSS, strong random secrets, an application-owned bearer-token
verifier, and a shared session store if more than one gateway instance is deployed. The
example's HMAC app token is only a local development helper.
