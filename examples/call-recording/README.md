# Call recording from the audio tap

This example uses the public `createVoiceAgent()` audio-tap option to capture a
complete mock call into a timestamp-aligned stereo WAV. Caller PCM is in the
left channel and transport-accepted agent PCM is in the right channel. When an
agent turn is interrupted, the example keeps the part before the successful
clear marker and trims the rest. Playout confirmation is optional; accepted
audio without confirmation is retained, but does not prove the caller heard it.

From the repository root, run:

```bash
pnpm --filter @tvic/example-call-recording start
```

The example uses deterministic mock STT, LLM, TTS, and transport implementations;
it makes no network requests and needs no API keys. It writes
`examples/call-recording/output/mock-call.wav`. Pass a different output path as
the first argument if needed:

```bash
pnpm --filter @tvic/example-call-recording start ./output/mock-call.wav
```

The example demonstrates the host-side integration pattern:

```ts
const agent = createVoiceAgent({
  prompt,
  providers,
  audioTap: {
    onFrame(frame) {
      if (frame.type === "audio") recordingQueue.push(frame);
      if (frame.type === "cleared") recordingQueue.markCleared(frame);
      if (frame.type === "playout") recordingQueue.markPlayout(frame);
    },
    onDrained({ sessionId, summary }) {
      // Every accepted tap frame has reached the host queue.
      return recordingQueue.flush(sessionId, summary);
    },
  },
});
```

`finalSession.audioTap` is captured when the runtime closes the tap. A callback
may still be pending at that point. The example waits for `onDrained` before it
builds the WAV, so callback failures observed while draining are included in the
summary it checks. TVIC does not wait for `onDrained`; if a host callback never
settles, the host should use its own timeout.

`frame.bytes` contains copied PCM in `frame.format`. `timestampMs` is the runtime's
monotonic session-relative observation time, shared across caller and agent frames.
Agent audio means the transport accepted the bytes; it does not prove the caller
heard all of them. If the send deadline expires before the transport result,
TVIC releases the copied bytes and counts the frame as dropped, even if that
send settles later.

A successful `cleared` marker gives a best-effort end time for output that the
transport removed. `cleared.throughSequence` is captured before TVIC calls
`clear()`, so later replies are outside that marker even if its promise settles
after they are sent. For each unconfirmed agent frame at or before that boundary,
the example clips the frame on the aligned sample timeline. It keeps
`clamp(0, frameSampleCount, floor(clear.timestampMs * sampleRateHz / 1000) - frameStartSample)`
samples. This preserves the part of an interrupted response the caller could
have heard instead of dropping the whole turn or keeping its entire queued tail.

If a send was unresolved when TVIC called `clear()`, `hadPendingSends` is true.
`pendingSendTurnIds` lists every turn with an unsettled send, so the example
also cuts late audio from an earlier turn when a later turn requested the clear.
If `pendingSendTurnIdsTruncated` is true, the example refuses to write a WAV:
it cannot tell whether a late agent frame belongs to the interrupted turn or a
later reply, and applying the cutoff to every later frame would corrupt that
reply. A host should mark that recording incomplete or use transport-specific
playout data to resolve the ambiguity. When a transport confirms playout, the
example keeps that confirmed audio in full. Without a clear or playout marker,
it preserves accepted agent audio and labels its limit: transport acceptance
does not prove the caller heard it.

Frames on each channel are written in tap-sequence order. If observation timestamps
overlap within a channel, the later frame starts after the earlier frame ends so
its samples are preserved; positive gaps remain aligned to their timestamps. The
WAV is an approximation when media arrives in batches or transport acceptance is
faster than playout. This mock example keeps captured frames and the completed WAV
in memory, and limits WAV data to 64 MiB. Use a streaming, host-owned recorder for
long calls.

TVIC does not save or manage recordings. The host application owns consent,
storage, retention, access controls, and any user-facing recording workflow.

Run the example checks with:

```bash
pnpm --filter @tvic/example-call-recording typecheck
pnpm --filter @tvic/example-call-recording test
```
