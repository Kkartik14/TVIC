# Remote runtime protocol v1

This document is the wire contract between TVIC's self-hosted Node worker and
language clients such as the Python package. It uses one WebSocket per live call.
The worker remains a consumer-run part of the open-source SDK; it is not a
TVIC-hosted API or account service.

## Connection and startup

Connect to `ws(s)://<consumer-worker>/v1/agents/<agent-id>`. The agent ID is a
stable name registered by the worker owner. A connection carries exactly one
call. The first client frame must be this JSON object:

```json
{
  "type": "agent.start",
  "protocolVersion": 1,
  "mode": "push_to_talk",
  "clientPlatform": "python"
}
```

`mode` is `push_to_talk` or `continuous`; `clientPlatform` is a short client
label of 1 to 64 UTF-16 code units. The worker responds with `agent.ready`, including its `sessionId`,
`callId`, registered `agentId`, and selected `audioFormat`. A worker error is
`agent.error` with a stable `code` and a bounded message. Clients must reject
protocol versions they do not support.

Startup order is strict: the worker sends `agent.ready`; the client sends
`session.start`; then the worker sends `session.ready`. Clients must reject
`session.ready` until they have successfully sent `session.start`, and must
reject it before a valid `agent.ready` or when `agent.ready.agentId` does not
match the requested route.

`agent.ready.maxControlFrameBytes` gives the negotiated maximum JSON control
frame size. The default worker limit is 32 KiB, configurable from 4 to 64 KiB.
If a `tool_call` event does not fit this limit, its `voice.event.input` is
replaced with `{ "$tvic": "input_truncated", "reason": "exceeds_control_frame_limit" }`.
If the corresponding Python tool dispatch cannot fit, the runtime reports it as
a tool error; it does not classify the size limit as socket backpressure.
If a `tool_result` event output cannot be represented within the outbound frame
or nesting limits, the worker sends that event with output set to
`{ "$tvic": "output_truncated", "reason": "exceeds_protocol_limits" }`.
This marker only affects the mirrored `voice.event`; the original tool result
has already been returned to the runtime.
If an `error` event exceeds those limits, the worker preserves its error name,
category, retry flag, and recoverability while replacing the message with a
bounded protocol-limit marker. It preserves the error code when it fits, or
uses `remote.error_truncated` when the code is too large. A present cause is
replaced with a bounded marker; an absent cause stays absent. Provider and
metadata details are omitted from that mirrored event.

After `agent.ready`, start the existing Web Client Audio media protocol:

```json
{
  "type": "session.start",
  "protocolVersion": 1,
  "mode": "push_to_talk",
  "clientPlatform": "python",
  "audioFormat": {
    "encoding": "pcm_s16le",
    "sampleRateHz": 16000,
    "channels": 1
  }
}
```

The worker responds with `session.ready`. This media protocol and its playback
acknowledgement behavior are shared with the browser transport documented in
[TVIC browser voice mode](../../examples/voice-mode/README.md).

## Audio and control messages

Audio is PCM16 little-endian, 16 kHz, mono. Binary frames have a 12-byte
little-endian header followed by an even number of audio bytes:

| Bytes | Meaning                                     |
| ----- | ------------------------------------------- |
| 0     | Protocol version `1`                        |
| 1     | Flags, currently `0`                        |
| 2–5   | Contiguous frame sequence, beginning at `1` |
| 6–9   | Monotonic offset in milliseconds            |
| 10–11 | Reserved, must be `0`                       |
| 12+   | PCM16 audio                                 |

Client controls are `turn.end` (push-to-talk only), `client.interrupt`,
`client.ping`, `output.playout_ack`, and `session.end`. The client should send a
ping every five seconds while connected. `output.playout_ack` must be sent only
after the output frames identified by the matching `output.commit` have played.

The worker sends `voice.event` messages for non-audio `VoiceEvent` values.
Audio output is sent as binary frames. It also forwards `assistant.text`,
`output.clear`, and `output.commit` controls from the Web Client Audio transport.
The worker's output audio sequence restarts at `1` after each `output.clear` or
`output.commit`; the client-to-worker input sequence remains contiguous for the
whole connection. The worker waits for the run iterator and its cleanup to
finish before forwarding its terminal `call_ended` event and `session.ended`.
If cleanup fails after a `completed` terminal event, it sends `voice.error`
instead of reporting successful completion.
`session.ended` marks normal completion. A WebSocket close before that control is
an interrupted connection, not normal completion. The control may include a
`reason`; when it is `failed`, the Python client yields queued voice events and
then raises `RemoteVoiceError` with code `session_failed`.

The Python client uses a bounded event queue (`max_pending_events`, default
256). If the queue fills, the event iterator raises `RemoteVoiceError` with code
`backpressure`; applications should drain events while a call is active.
The client also bounds pending tool calls per session. If that limit is reached,
it closes the session with `RemoteVoiceError` code `tool_capacity` and cancels
active local handlers. The process-wide synchronous handler pool has a separate
limit; when it is full, the client returns `tool.error` for the new call. The
async handler limit applies per session; the application controls aggregate
async work through its session admission and handler design.

## Python tool calls

Tools are declared by the worker owner with a name and input/output JSON
schemas. Python implements handlers under those names. A request from the worker
looks like:

```json
{
  "type": "tool.call",
  "toolCallId": "tool_...",
  "sessionId": "session_...",
  "turnId": "turn_...",
  "toolId": "lookup_customer",
  "toolName": "lookup_customer",
  "attempt": 1,
  "idempotencyKey": "session_...:tool_...",
  "timeoutMs": 30000,
  "input": { "email": "person@example.com" }
}
```

`timeoutMs` is a positive finite JSON number of milliseconds; fractional values
are valid.

The client returns either:

```json
{ "type": "tool.result", "toolCallId": "tool_...", "output": { "found": true } }
```

or:

```json
{ "type": "tool.error", "toolCallId": "tool_...", "error": { "message": "lookup failed" } }
```

The worker sends `tool.cancel` when TVIC cancels or times out the callback. A
late result after cancellation is ignored. Cancellation cannot undo an external
side effect that has already started; handlers should use the supplied stable
`idempotencyKey` when their operation needs deduplication.

JSON numbers must be finite, and numbers whose value is an integer must be
within JavaScript's safe integer range (`-9007199254740991` through
`9007199254740991`) to preserve their value across languages. The worker rejects
a control frame containing a non-finite or out-of-range number with
`session.error` and closes the connection. Python tool handlers that return
non-finite numbers or larger exact integers receive `tool.error`; encode large
identifiers or monetary minor units as decimal strings instead.

Python `tool.result` frames are limited to 511 nested JSON objects and arrays,
counting the outer frame object. This leaves one level for the worker's
`voice.event` envelope within its 512-level outbound traversal bound. An
over-deep Python tool result is sent as `tool.error`, so the call can continue.

## Ownership and lifecycle

The worker owner configures agents and provider credentials in its Node process.
The Python client cannot create or mutate worker agent definitions. Each
connection starts one session; disconnecting cancels that session. V1 does not
resume a live call after a worker restart or socket loss.

TVIC does not provide authentication. The application decides how the worker is
exposed and may pass a synchronous upgrade authorization callback to
`createRemoteVoiceService`. That callback can return application identity and
tenant context for the run. Python clients can send application-owned headers.
No authorization context is trusted from the client handshake.
