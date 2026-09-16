# `@tvic/runtime` internal package

This package contains the runtime implementation used by the public
`voice-runtime` package. Applications should import the supported root exports
from `voice-runtime`, not unpublished workspace paths.

## Internal architecture notes

- [Deadlines and queues](./DEADLINES-QUEUES.md)
- [Event ordering](./EVENT-ORDERING.md)
- [Failure normalization](./FAILURE-NORMALIZATION.md)
- [Lifecycle invariants](./LIFECYCLE-INVARIANTS.md)

## Public learning paths

- [Building a voice agent](../../docs/building-a-voice-agent.md)
- [Testing](../../docs/testing.md)
- [API reference](../../docs/api-reference.md)

## Main source areas

| Area                       | Files                                                               |
| -------------------------- | ------------------------------------------------------------------- |
| Runtime creation           | `create-runtime.ts`, `runtime-support.ts`                           |
| Agent and tool definitions | `define-agent.ts`, `define-tool.ts`                                 |
| Voice loop                 | `pipeline-loop.ts`, `pipeline-loop-tts.ts`, `pipeline-stt-input.ts` |
| Session and turn state     | `runtime-turns.ts`, `turn-state.ts`, `session-end.ts`               |
| Context and memory         | `pipeline-memory.ts`, `pipeline-persona.ts`, `memory-loader.ts`     |
| Media server               | `node-media-plane.ts`                                               |
| Recovery and shutdown      | `resilient-stt.ts`, `session-recovery.ts`, `runtime-shutdown.ts`    |

Keep changes to this package covered by public-seam tests where possible. The
architecture notes describe invariants that must remain true when refactoring.
