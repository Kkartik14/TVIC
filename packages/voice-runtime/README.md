# voice-runtime

[![npm](https://img.shields.io/npm/v/voice-runtime.svg)](https://www.npmjs.com/package/voice-runtime)
[![CI](https://github.com/Kkartik14/TVIC/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Kkartik14/TVIC/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

`voice-runtime` is the public npm entry point for
[TVIC](https://github.com/Kkartik14/TVIC), a provider-neutral runtime for realtime
voice agents with bring-your-own telephony, speech, model, and synthesis providers.

## Status: early preview

This `0.0.x` release reserves the stable package name while the high-level
`createVoiceAgent` API is completed. **It does not yet export the executable
runtime, and it should not be used in production.**

Publishing an explicit placeholder is intentional. Shipping an unfinished runtime
API under a stable name would be worse than shipping nothing.

The runtime itself is executable today and developed in the open. To run it now,
work from the [repository](https://github.com/Kkartik14/TVIC) rather than from this
package.

## What TVIC does

Accepts call media, transcribes speech, decides when a caller actually finished
their turn, runs a model and tools, synthesizes a reply incrementally, streams audio
back, and handles interruption, cancellation, provider stalls, and hangup.

Recordings, traces, incident analysis, and dashboards are deliberately out of scope.
Those belong to Earshot, a separate voice observability product that integrates
outside the realtime critical path.

## License

[Apache-2.0](./LICENSE)
