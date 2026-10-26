# Provider capability snapshot simulation

Run `pnpm build`, then start the simulation with
`pnpm provider:snapshot-simulation:serve`. In another shell, run
`pnpm provider:snapshot-simulation:check:all` to execute the success, 408, and
429 cases. To run one case, use
`pnpm provider:snapshot-simulation:check -- cartesia-429`. Stop the simulation
with Ctrl-C and keep its output outside the repository.

The script calls the built Cartesia and ElevenLabs snapshot loaders with a fetch
adapter that preserves each URL path, query, headers, and abort signal while
routing it through the local simulation. It uses fake API keys. The mock
contracts were generated from the providers' official API references and cover
only the read endpoints used here: Cartesia Get Voice and ElevenLabs List Models
and List Voices. The successful ElevenLabs example exercises `high_quality` and
a null locale followed by a valid locale. The error cases use documented status
responses exposed by the generated mocks with `x-mock-response-code`.

This simulation checks the loader's real fetch, response parsing, capability
facts, status mapping, and independent provider requests against local HTTP
stand-ins. It does not cover TTS synthesis, WebSocket traffic, account-specific
voice results, or vendor behavior. Use a real provider check for those claims.

The generated mock handlers are CommonJS, isolated by
`postman/mocks/package.json` so they remain loadable inside this repository's
ES module package.

## Live provider checks

- 2026-10-26: The same snapshot loaders ran against the configured Cartesia and
  ElevenLabs accounts using read-only requests. Cartesia returned a supported
  voice and a supported `is_pro: false` fact; ElevenLabs returned a supported
  voice, the `premade` category, and one verified locale. API keys and voice
  IDs were not printed. This confirms the authenticated loader paths and those
  current account records only; it does not generalize to other voices.
- 2026-10-26: Sarvam WebSocket Bulbul v4 Flash accepted `temperature: 0.5` and
  returned six audio chunks (125,400 PCM bytes). This proves request acceptance
  and output, not that temperature changes v4 prosody; current vendor guidance
  says v4 ignores temperature.
- 2026-10-26: The TTS failover live smoke completed normally through Sarvam and
  through the forced ElevenLabs fallback, with one committed turn on each
  route. No audio files or credentials were written to the repository.

## Run record

- 2026-10-27 (final verification): Postman CLI 1.75.0 served both local mocks
  on port 4300. The success, Cartesia 408/429, and ElevenLabs 408/429 cases all
  passed. Both members served traffic: 5 Cartesia voice requests, 5 ElevenLabs
  model-list requests, and 3 ElevenLabs voice requests. The CLI process was
  stopped and its output stayed outside the repository. This validates the
  snapshot loader paths against local stand-ins; it does not exercise TTS
  synthesis or vendor behavior.
- 2026-10-26: Postman CLI 1.75.0 served both local mocks. The success case and
  all four error cases passed. The success case asserted Cartesia voice
  availability, ElevenLabs model and voice availability, the `high_quality`
  category, and recovery of `en-US` after a null locale. Cartesia 408/429 and
  ElevenLabs 408/429 produced retriable `provider.upstream_failed` or
  `provider.rate_limited` errors with the HTTP status attached. The log showed
  both members serving their expected routes (9 successful and 4 error
  responses); neither member was silent. The simulation process was stopped
  after the run and its log was not kept in the repository.
