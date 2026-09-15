# Runtime lifecycle invariants (Team 2, R2-01)

Owning contracts: `packages/core/src/session.ts`, `turn.ts`, `media.ts`, `tool.ts`, `dal.ts`.
Implementation: `packages/runtime/src/create-runtime.ts`, `runtime-turns.ts`, `tool-lifecycle.ts`, `pipeline-loop.ts`.

## Session

| From                                            | To                             | Observable                                                     | Resources                                                                                                                | Repeat                                                          | Failure                                                                                         |
| ----------------------------------------------- | ------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| start                                           | `active`                       | `session.start` metric, snapshot 0 turns                       | lease `fence=1`, heartbeat 1s, `sessionStartMs`, `SessionEndCoordinator.open()`                                          | new id per call                                                 | `criticalWrite` 75ms -> `BackendUnavailableError`, late commit abandoned                        |
| `active\|interrupted\|waiting_for_tool\|ending` | attached                       | snapshot + `preCallContext`                                    | new lease `fence+1`, heartbeat, orphans -> `cancelled(runtime_restarted)`, running tools replayed or `failed(ambiguous)` | second attach while attached -> `LeaseUnavailableError`         | lease fail -> no attachment stored                                                              |
| any active-family                               | `completed\|failed\|cancelled` | `session.end` metric, `onSessionEnd` 5s, memory drain+purge 1s | detach (abort, clear heartbeat, release lease 1s), clocks deleted                                                        | `endSession` on terminal returns existing, detaches, no re-emit | fenced tx throws -> `BackendUnavailableError`; late commit finalizes via `finishLateSessionEnd` |
| any                                             | stop                           | none                                                           | `onShutdownStart` 5s, detach all, clear clocks, close store                                                              | idempotent via `#stopPromise`; restart throws                   | store close failure propagates                                                                  |

CORRECTED (red P1-01): ONLY `status==="active"` accepts `startTurn`/`startToolCall`/`recordToolCall`. `interrupted|waiting_for_tool|ending` are attachable but do NOT accept new turns/tools until back to `active`. Terminal rejects all three.

## Turn

| From                | To                                                             | Event                                | Resources                                                    | Repeat                                                |
| ------------------- | -------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------ | ----------------------------------------------------- |
| start               | `started`                                                      | `turn_started` + `transcript_delta`  | `turnSequence+1`, `currentTurnId`, outbox `turn+session`     | new id per call                                       |
| active non-terminal | `thinking\|calling_tool\|speaking\|listening`                  | none (outbox only)                   | `lastActivityWallAtMs` + outbox                              | terminal ignores updates (returns current)            |
| any active          | `interrupted` via `checkpointTurnInterruption` (authoritative) | none                                 | `interruptionReason` + outbox                                | idempotent per turn                                   |
| any active          | `completed\|cancelled\|failed` via `endTurn`                   | `turn_completed` + `turn.end` metric | `currentTurnId` cleared, `pendingToolCallIds` pruned, outbox | `endTurn` on terminal returns existing (no overwrite) |

Rejected: `updateTurnStatus(completed|cancelled|failed)` throws (must use `endTurn`); `updateTurnStatus(started)` is a validated read. `interrupted->speaking|thinking|calling_tool|listening` resurrection is FORBIDDEN (returns current `interrupted`); only `endTurn` or a new turn leaves `interrupted`.

## Media (`CallHandle` contract, fakes here; real Twilio/browser proof is T3 P3-02/P3-03)

`close(reason)` idempotent; `send` after close resolves `false` (never throws); `clear` after close no-op resolves. Ownership: the voice loop NEVER calls `callHandle.close` except on STT-input failure (`close("error")`); terminal transport close is host-owned (managed `closeCall`, proven exactly-once in `voice-runtime`).

## Tool

`queued->running->terminal`. `finishToolCall` on terminal returns current after identity check (mismatch -> `RecordConflictError`; `queuedAt` string equality, with clock skew across restart as a known edge). `recordToolCall` running plus queued keeps `running` and does not reject. `finish-without-start` inserts a terminal record. Same-id same-payload `put` succeeds; different payload returns `RecordConflictError`.

## Behavior changes in this release (for Team 1 changelog)

- Barge-in gate widened from `speaking` to `active && !outputDelivered`: background speech during LLM streaming, TTS setup, tool execution, and playout-confirm wait now interrupts. Callers tuned on the old semantics observe strictly more interruptions.
- DTMF interrupts from ANY active turn state (thinking/calling_tool included); `media.interrupt.requested` stays speaking-gated (explicit playout-interrupt by design).
- `updateTurnStatus` rejects `"interrupted"` (route to `checkpointTurnInterruption`, which is idempotent per turn. Repeat checkpoints keep the first reason).
- `commitMode:none` providers resolve commit barriers locally (no provider round-trip, no commit timeout).
- Unfenced in-memory writes against a live fenced owner now throw `LeaseLostError` (never last-writer-wins).
- Awaiters reject with the same normalized error value iterators yield (raw provider identity no longer preserved across the run boundary).
