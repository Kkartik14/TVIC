# Runtime tracing

TVIC can project a terminal session into an opt-in `RuntimeSessionTrace` for
metrics or trace systems. The projection is built from an explicit field
allowlist. It contains lifecycle and performance metadata; it does not contain
conversation content.

**Release status:** `RuntimeSessionTrace`, `toRuntimeSessionTrace()`, and
`onSessionTrace` are part of the 2.0.0 package surface. Consumers on an earlier
package version should check the installed declarations before using these APIs.
See the [API reference](./api-reference.md#version-and-release-status).
The optional `audioTap` and session `usage` fields are additive in
`voice-runtime@2.1.0`; both retain trace schema version 1.

Source: [`RuntimeSessionTrace`](../packages/core/src/runtime.ts) and its
allowlisted projection in [`session-trace.ts`](../packages/runtime/src/session-trace.ts).

## Enable the trace callback

Set `runtime.sessionMetricsRecorder.onSessionTrace` when creating the agent or
runtime. Keep the callback synchronous and fast. It is called during session
finalization, and TVIC does not wait for a returned promise. Put network I/O
behind a bounded local queue and define what happens when that queue is full.

The callback is optional. A thrown error or rejected promise does not change the
session outcome. TVIC does not send traces to an external service.

## Trace contents

`RuntimeSessionTrace` contains:

- Session, call, agent, turn, and tool-call IDs; channel; terminal status and
  source; and ISO 8601 UTC timestamps.
- Turn status, monotonic latency measurements, audio/text delivery evidence,
  and normalized error code, category, and retryability.
- Tool-call status, attempt count, and normalized error fields.
- An optional session `usage` summary with provider/model attribution, measured
  runtime values, provider-reported values, and explicit missing or interrupted
  coverage. Usage contains no prices or currency.
- The opt-in audio-tap enabled flag and counts of dropped audio frames,
  dropped control events, and callback errors. No audio bytes are included.
- A snapshot status and counts. The status is `available`, `timed_out`, or
  `unavailable`. The projection keeps the most recent 500 turns and 1,000 tool
  calls and reports counts omitted by those limits.

The trace has `schemaVersion` and `privacy` fields at its root. Its `session`
object holds the session identity, channel, terminal status/source, timestamps,
and optional normalized error summary. `snapshot` reports completeness and
counts. `turns` holds turn identity, sequence, status, timestamps, latency,
delivery, and optional error summary. `toolCalls` holds call and turn IDs,
status, attempt count, timestamps, and optional error summary. Optional values
are omitted when the runtime has no value to report.

When a pipeline reports audio-tap counters, the root `audioTap` object contains
only `enabled`, `droppedFrames`, `droppedEvents`, and `callbackErrors`. These
counters are transient runtime state; they are not written to the durable
session record. `callbackErrors` is captured when the pipeline closes the tap.
The runtime does not wait for pending host callbacks, so a later rejection is
caught but does not revise the trace snapshot.

## Session usage

`usage` is an optional root field in `RuntimeSessionTrace`; it is also available
on `SessionEndEvent` when the managed voice pipeline supplies a summary. The
managed facade includes a usage summary on every `finalSession`, including an
empty `entries` list when no provider operation ran. When both surfaces are
present, they carry the same frozen values. The trace remains schema version 1.

Entries are grouped by operation kind, provider, and model. `modelSource`
identifies whether the model came from the provider, request, configuration, or
was unavailable. An explicit `models.*` selection is `request`; a provider's
configured model is `configured`. An implicit catalog or capability default has
source `not_reported`, even when the selected model name is known. Each metric
includes a status, source, unit, and value where
known. `measured` means the runtime counted a boundary; `reported` means the
provider supplied the value. `partial` includes the observed subtotal and the
number of operations not reported by reason. `not_reported` never implies zero.

LLM request counts include each runtime `complete()` call, including tool
continuations. Input, output, and cached tokens are provider-reported;
`cachedTokens` is a subset of input tokens. STT `audioMsSent` counts successful
physical audio writes, including successful reconnect replays. TTS
`charactersSent` counts Unicode code points at the adapter's text submission or
write-attempt boundary. It may include text from a connection or write that
later fails; the count does not prove provider receipt or billing. Cartesia
counts serialized transcript text, including any control markup and escaping
applied during serialization, when the adapter attempts a write; buffered text is counted only when emitted.
ElevenLabs and Sarvam count submitted plain text, with route-specific accounting
before connection or send validation. `audioMsReceived` is measured from PCM
frames read from the provider stream. Neither text submission nor received audio
means the provider billed that amount or the caller heard it.

The runtime freezes usage synchronously when terminalization begins. It does not
wait for streams or writes to finish solely for usage data. In-flight metrics
are marked interrupted; values arriving after the snapshot do not revise it.
Non-additive provider observations retain at most the first 32 values, along
with count, minimum, maximum, and a truncated count. Batch transcription does
not enter live-session usage. TVIC does not report prices, currency, or persist
usage to the durable session record.

The trace explicitly excludes transcripts, audio, tool names, tool arguments,
tool results, provider error messages, session metadata, variables, and memory.
It is still metadata, not anonymous data: IDs, timestamps, status, latency, and
error codes can identify or reveal information about a person or interaction.

TVIC passes `Call.id` and the agent ID through unchanged and does not enforce
that they are opaque. Choose non-identifying IDs for those fields and for any
custom `IdGenerator`; apply access controls, retention, and deletion policies
at the destination. The runtime generates session, turn, and tool-call IDs by
default, but a custom generator owns the privacy of its values.

Latency values are monotonic durations. `firstAudioMs` measures from endpoint
commit until the first audio frame is accepted by the transport; it does not
mean the caller heard the frame.

The trace reports audio and text delivery independently:

| Value                 | Meaning                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------ |
| `not_attempted`       | TVIC did not attempt that output channel.                                                  |
| `not_accepted`        | An output attempt did not reach the transport.                                             |
| `partially_accepted`  | Some audio frames reached the transport, but the audio stream did not finish.              |
| `transport_accepted`  | The transport accepted output; this does not establish playback or reading.                |
| `playout_confirmed`   | The transport's `confirmPlayout` acknowledgement returned true; this is not proof heard.   |
| `playout_unconfirmed` | Audio was accepted, but the configured acknowledgement was absent, negative, or timed out. |

`partially_accepted`, `playout_confirmed`, and `playout_unconfirmed` apply to
audio. Text uses `not_attempted`, `not_accepted`, or `transport_accepted`.
Text acceptance does not show that the caller read it.

## Keep content-bearing callbacks separate

The full `VoiceEvent` stream includes caller text, audio bytes, tool names and
arguments/results, and provider error details. The opt-in `onTurn` and
`onSessionEnd` hooks also receive richer turn or session data; `onSessionEnd`
includes a memory snapshot. Review and redact those surfaces before exporting
them. Use `onSessionTrace` when metadata-only output is sufficient.
