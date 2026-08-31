BEGIN;

-- `entry_id` uses gen_random_uuid(); keep the migration self-contained for a
-- fresh PostgreSQL installation rather than relying on an operator-created
-- extension.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Epoch milliseconds (bigint) — the rest of the runtime uses `Date.now()`
-- and `clock: () => Date.parse(...)`, so all timestamps are stored as
-- ms-epoch integers. Matches the runtime's clock type end-to-end.
CREATE TABLE IF NOT EXISTS tvic_memory_entries (
  scope_kind text NOT NULL CHECK (scope_kind IN ('session', 'user', 'organization', 'workflow')),
  scope_id text NOT NULL,
  kind text NOT NULL CONSTRAINT tvic_memory_entries_kind_check
    CHECK (kind IN ('fact', 'summary', 'open_item', 'entity_ref', 'raw', 'working_memory')),
  key text NOT NULL,
  value jsonb NOT NULL,
  -- UTF-8 bytes of PostgreSQL's canonical jsonb text for quota accounting.
  value_bytes bigint NOT NULL CHECK (value_bytes >= 0),
  version bigint NOT NULL DEFAULT 1,
  created_at_ms bigint NOT NULL DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint),
  updated_at_ms bigint NOT NULL DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint),
  expires_at_ms bigint,
  memory_user_id text,
  tags jsonb,
  metadata jsonb,
  -- Stable per-entry identity, distinct from the composite primary key.
  -- Two rows with the same `(scope_kind, scope_id, kind, key)` but
  -- different `entry_id` are impossible because the primary key
  -- enforces uniqueness on the composite. `entry_id` exists so that
  -- `MemoryEntry.id` is a stable per-row identity even after a delete
  -- + re-put (which produces a new `entry_id`). Postgres
  -- `gen_random_uuid()` is built into pgcrypto (PG 13+).
  entry_id uuid NOT NULL DEFAULT gen_random_uuid(),
  PRIMARY KEY (scope_kind, scope_id, kind, key)
);

-- `memory_user_id` is trusted runtime attribution for session-scope writes
-- only. It is kept out of caller metadata so `Memory.deleteForUser(userId)`
-- can remove the user's user-scope entries and explicitly attributed session
-- entries without treating arbitrary metadata as ownership. Organization and
-- workflow scopes are shared and are never part of that user cascade.
-- The partial index keeps the attributed-session deletion selective.
CREATE INDEX IF NOT EXISTS tvic_memory_entries_memory_user_id_idx
  ON tvic_memory_entries (memory_user_id)
  WHERE scope_kind = 'session' AND memory_user_id IS NOT NULL;

-- Partial indexes keyed by scope_kind so each scope's queries hit a
-- tiny index. Each index is keyed on (scope_id, kind, key) which matches
-- the prefix used in the runtime's #updateMemory and pre-call loader.
CREATE INDEX IF NOT EXISTS tvic_memory_entries_user_idx
  ON tvic_memory_entries (scope_id, kind, key)
  WHERE scope_kind = 'user';

CREATE INDEX IF NOT EXISTS tvic_memory_entries_session_idx
  ON tvic_memory_entries (scope_id, kind, key)
  WHERE scope_kind = 'session';

CREATE INDEX IF NOT EXISTS tvic_memory_entries_org_idx
  ON tvic_memory_entries (scope_id, kind, key)
  WHERE scope_kind = 'organization';

CREATE INDEX IF NOT EXISTS tvic_memory_entries_workflow_idx
  ON tvic_memory_entries (scope_id, kind, key)
  WHERE scope_kind = 'workflow';

CREATE INDEX IF NOT EXISTS tvic_memory_entries_expires_idx
  ON tvic_memory_entries (expires_at_ms)
  WHERE expires_at_ms IS NOT NULL;

-- The table may have been created by an early 0.1 release before `kind` had
-- a database constraint. Add it idempotently so old installations get the
-- same corruption boundary as fresh installations.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'tvic_memory_entries'::regclass
       AND conname = 'tvic_memory_entries_kind_check'
  ) THEN
    ALTER TABLE tvic_memory_entries
      ADD CONSTRAINT tvic_memory_entries_kind_check
      CHECK (kind IN ('fact', 'summary', 'open_item', 'entity_ref', 'raw', 'working_memory'));
  END IF;
END $$;

COMMIT;
