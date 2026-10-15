# Runtime tracing

TVIC can project a terminal session into an opt-in `RuntimeSessionTrace` for
metrics or trace systems. The projection is built from an explicit field
allowlist. It contains lifecycle and performance metadata; it does not contain
conversation content.

**Release status:** the trace APIs described here are available in this
checkout but are not yet included in published `voice-runtime@1.2.0`. See the
[API reference release note](./api-reference.md#release-status-checked-2026-09-30)
and check the installed package declarations before using them from npm.

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
