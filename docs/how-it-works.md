# How TVIC works

TVIC is a cascaded voice runtime. In other words, one stage passes its result to
the next: speech to text, then the language model, then text to speech. Each
stage has a clear boundary and a contract that does not depend on one vendor.

```text
┌───────────┐   media    ┌─────┐ transcript  ┌──────────────┐
│ Transport │ ─────────▶ │ STT │ ──────────▶ │ Turn runtime │
└───────────┘             └─────┘            └──────┬───────┘
      ▲                                             │
      │ audio                                       │ messages + tools
      │                                             ▼
      │                                      ┌──────────────┐
      │                                      │ LLM / tools  │
      │                                      └──────┬───────┘
      │                                             │ text
      │                                             ▼
      │                                      ┌──────────────┐
      └────────────────────────────────────│     TTS      │
                                             └──────────────┘
```

## Transport

The transport converts a browser or phone connection into a `CallHandle`. This is
the connection object TVIC uses after your application authenticates the caller.
A handle provides:

- an async stream of normalized inbound media events;
- `send()` for outbound audio;
- `clear()` for queued audio during interruption;
- `close()` for session shutdown;
- optional playout confirmation.

The transport is deliberately separate from the runtime. Your application remains
responsible for authenticating the connection before it reaches TVIC.

## Speech-to-text

TVIC sends canonical PCM16 little-endian audio to the selected STT provider. The
adapter normalizes provider messages into partial transcripts, final transcripts,
speech signals, and endpoint information.

A final transcript is not automatically the same thing as a completed turn. TVIC
uses endpointing, voice activity detection (VAD), manual commits, interruption
policy, and timing limits to decide when the caller has finished.

## Turn runtime

For each committed caller turn, TVIC creates a durable or in-memory turn record,
assembles the conversation context, and starts the model/tool work. Turn state
tracks whether the turn is thinking, calling a tool, speaking, completed,
cancelled, or failed.

The runtime treats these as different facts:

- the provider accepted output;
- the transport received output;
- the transport cleared output;
- the caller actually heard output.

This distinction prevents an interrupted or unplayed response from being recorded
as a successful conversation turn.

## LLM and tools

The LLM receives the system instructions, conversation messages, and available
tool schemas. TVIC validates tool arguments and results, applies timeouts and
abort signals, and records tool lifecycle state.

Tools are application-owned. A tool can call a calendar, CRM, payment service, or
workflow engine, but TVIC does not authorize that action on the application's
behalf. Irreversible tools should enforce authorization and confirmation in the
application layer and use idempotency where retries could duplicate work.

## Text-to-speech and interruption

If the provider supports incremental synthesis, TVIC can send text while the LLM
is still generating. Output is sent to the transport and tracked for playout.

When the caller interrupts, TVIC aborts the active model/TTS work, clears queued
transport output when supported, and records the response as cancelled unless it
was already delivered according to the transport's evidence.

## Events

The managed run exposes a small `VoiceEvent` stream:

- `transcript_delta`
- `audio_output`
- `turn_started`
- `turn_completed`
- `tool_call`
- `tool_result`
- `error`
- `call_ended`

Errors carried by events are JSON-safe normalized values. A thrown error and an
event error are intentionally different boundaries; applications should use
`isNormalizedError` for event payloads.

## Persistence

TVIC can use in-memory stores for development or injected durable stores for
production. PostgreSQL is authoritative for the composite durable runtime store;
Redis provides the cache/projection layer. Memory adapters are optional and must
be configured explicitly.

TVIC owns live session, turn, tool, and provider execution state. The application
owns durable business state and decides what conversation or memory data should be
retained.

## Failure behavior

Provider connection failures, malformed messages, stalled streams, tool timeouts,
transport loss, persistence failures, and caller hangup are separate failure
classes. TVIC normalizes them and attempts to close active work before ending the
session.

TVIC does not claim that audio or STT input is delivered exactly once across
provider reconnects.
With STT recovery enabled, audio around a failure may be lost or recognized twice;
that trade-off is explicit in the reconnect policy.
