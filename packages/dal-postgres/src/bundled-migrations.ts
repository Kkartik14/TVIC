/**
 * GENERATED FILE. Run `node scripts/generate-migration-bundles.mjs`
 * after changing a migration SQL file. The .sql files remain the source of
 * truth and are also shipped for operators who prefer to inspect or run them
 * manually.
 */
export const BUNDLED_POSTGRES_MIGRATIONS = [
  {
    version: 1,
    name: "001_durable_runtime.sql",
    sql: String.raw`BEGIN;

CREATE TABLE IF NOT EXISTS tvic_sessions (
  id text PRIMARY KEY,
  agent_id text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  started_at timestamptz,
  ended_at timestamptz,
  payload jsonb NOT NULL,
  runtime jsonb NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  last_fence bigint NOT NULL DEFAULT 0,
  last_activity_at timestamptz NOT NULL,
  recovery_deadline_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tvic_sessions_activity_idx
  ON tvic_sessions (last_activity_at, id);

CREATE INDEX IF NOT EXISTS tvic_sessions_recovery_idx
  ON tvic_sessions (recovery_deadline_at, id)
  WHERE status IN ('active', 'interrupted', 'waiting_for_tool', 'ending');

CREATE TABLE IF NOT EXISTS tvic_turns (
  session_id text NOT NULL REFERENCES tvic_sessions (id) ON DELETE CASCADE,
  id text NOT NULL,
  turn_sequence integer NOT NULL,
  status text NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  payload jsonb NOT NULL,
  runtime jsonb NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  last_fence bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, id),
  UNIQUE (session_id, turn_sequence)
);

CREATE INDEX IF NOT EXISTS tvic_turns_session_order_idx
  ON tvic_turns (session_id, turn_sequence, id);

CREATE TABLE IF NOT EXISTS tvic_tool_calls (
  session_id text NOT NULL REFERENCES tvic_sessions (id) ON DELETE CASCADE,
  id text NOT NULL,
  turn_id text NOT NULL,
  status text NOT NULL,
  queued_at timestamptz NOT NULL,
  started_at timestamptz,
  ended_at timestamptz,
  payload jsonb NOT NULL,
  runtime jsonb NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  last_fence bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, id),
  FOREIGN KEY (session_id, turn_id)
    REFERENCES tvic_turns (session_id, id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS tvic_tool_calls_session_order_idx
  ON tvic_tool_calls (session_id, queued_at, id);

CREATE INDEX IF NOT EXISTS tvic_tool_calls_status_idx
  ON tvic_tool_calls (status, updated_at, session_id);

CREATE TABLE IF NOT EXISTS tvic_session_leases (
  session_id text PRIMARY KEY REFERENCES tvic_sessions (id) ON DELETE CASCADE,
  holder text NOT NULL,
  fence bigint NOT NULL,
  acquired_at_ms bigint NOT NULL,
  renewed_at_ms bigint NOT NULL,
  expires_at_ms bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tvic_session_leases_expiry_idx
  ON tvic_session_leases (expires_at_ms, session_id);

CREATE TABLE IF NOT EXISTS tvic_tool_idempotency (
  key text PRIMARY KEY,
  tool_id text,
  tool_version text,
  session_id text,
  turn_id text,
  tool_call_id text,
  request_hash text NOT NULL,
  status text NOT NULL,
  owner text,
  claimed_fence bigint,
  claimed_at_ms bigint,
  expires_at_ms bigint NOT NULL,
  output jsonb,
  error jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tvic_tool_idempotency
  ADD COLUMN IF NOT EXISTS session_id text,
  ADD COLUMN IF NOT EXISTS claimed_fence bigint,
  ADD COLUMN IF NOT EXISTS tool_id text,
  ADD COLUMN IF NOT EXISTS tool_version text;

CREATE INDEX IF NOT EXISTS tvic_tool_idempotency_expiry_idx
  ON tvic_tool_idempotency (expires_at_ms, key);

CREATE TABLE IF NOT EXISTS tvic_outbox (
  id text PRIMARY KEY,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  session_id text NOT NULL REFERENCES tvic_sessions (id) ON DELETE RESTRICT,
  version bigint NOT NULL,
  fence bigint NOT NULL,
  envelope jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  claimed_by text,
  claim_expires_at timestamptz,
  delivered_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error jsonb
);

CREATE INDEX IF NOT EXISTS tvic_outbox_pending_idx
  ON tvic_outbox (created_at, id)
  WHERE delivered_at IS NULL;

CREATE INDEX IF NOT EXISTS tvic_outbox_claim_idx
  ON tvic_outbox (claim_expires_at, created_at, id)
  WHERE delivered_at IS NULL;

COMMIT;
`,
  },
  {
    version: 2,
    name: "002_outbox_retention_safety.sql",
    sql: String.raw`BEGIN;

ALTER TABLE tvic_outbox DROP CONSTRAINT IF EXISTS tvic_outbox_session_id_fkey;
ALTER TABLE tvic_outbox
  ADD CONSTRAINT tvic_outbox_session_id_fkey
  FOREIGN KEY (session_id) REFERENCES tvic_sessions (id) ON DELETE RESTRICT;

COMMIT;
`,
  },
  {
    version: 3,
    name: "003_sync_lifecycle_columns.sql",
    sql: String.raw`BEGIN;

UPDATE tvic_sessions
SET started_at = CASE
      WHEN payload ? 'startedAt' THEN (payload->>'startedAt')::timestamptz
      ELSE NULL
    END,
    ended_at = CASE
      WHEN payload ? 'endedAt' THEN (payload->>'endedAt')::timestamptz
      ELSE NULL
    END
WHERE started_at IS DISTINCT FROM CASE
        WHEN payload ? 'startedAt' THEN (payload->>'startedAt')::timestamptz
        ELSE NULL
      END
   OR ended_at IS DISTINCT FROM CASE
        WHEN payload ? 'endedAt' THEN (payload->>'endedAt')::timestamptz
        ELSE NULL
      END;

UPDATE tvic_turns
SET started_at = (payload->>'startedAt')::timestamptz,
    ended_at = CASE
      WHEN payload ? 'endedAt' THEN (payload->>'endedAt')::timestamptz
      ELSE NULL
    END
WHERE started_at IS DISTINCT FROM (payload->>'startedAt')::timestamptz
   OR ended_at IS DISTINCT FROM CASE
        WHEN payload ? 'endedAt' THEN (payload->>'endedAt')::timestamptz
        ELSE NULL
      END;

UPDATE tvic_tool_calls
SET started_at = CASE
      WHEN payload ? 'startedAt' THEN (payload->>'startedAt')::timestamptz
      ELSE NULL
    END,
    ended_at = CASE
      WHEN payload ? 'endedAt' THEN (payload->>'endedAt')::timestamptz
      ELSE NULL
    END
WHERE started_at IS DISTINCT FROM CASE
        WHEN payload ? 'startedAt' THEN (payload->>'startedAt')::timestamptz
        ELSE NULL
      END
   OR ended_at IS DISTINCT FROM CASE
        WHEN payload ? 'endedAt' THEN (payload->>'endedAt')::timestamptz
        ELSE NULL
      END;

COMMIT;
`,
  },
  {
    version: 4,
    name: "004_recovery_candidate_disposition.sql",
    sql: String.raw`BEGIN;

ALTER TABLE tvic_session_leases
  ADD COLUMN IF NOT EXISTS recovery_acknowledged_fence bigint;

COMMIT;
`,
  },
  {
    version: 5,
    name: "005_lease_generation_identity.sql",
    sql: String.raw`BEGIN;

ALTER TABLE tvic_session_leases
  ADD COLUMN IF NOT EXISTS generation_id uuid,
  ADD COLUMN IF NOT EXISTS recovery_acknowledged_generation_id uuid;

ALTER TABLE tvic_tool_idempotency
  ADD COLUMN IF NOT EXISTS claimed_generation_id text;

CREATE OR REPLACE FUNCTION tvic_assign_session_lease_generation_id()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.fence IS DISTINCT FROM OLD.fence THEN
    IF NEW.generation_id IS NULL OR NEW.generation_id = OLD.generation_id THEN
      NEW.generation_id := gen_random_uuid();
    END IF;
    NEW.recovery_acknowledged_fence := NULL;
    NEW.recovery_acknowledged_generation_id := NULL;
  END IF;
  IF NEW.generation_id IS NULL THEN
    NEW.generation_id := gen_random_uuid();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tvic_session_lease_generation_id_trigger ON tvic_session_leases;
CREATE TRIGGER tvic_session_lease_generation_id_trigger
  BEFORE INSERT OR UPDATE ON tvic_session_leases
  FOR EACH ROW
  EXECUTE FUNCTION tvic_assign_session_lease_generation_id();

COMMIT;
`,
  },
  {
    version: 6,
    name: "006_lease_generation_backfill_index.sql",
    sql: String.raw`CREATE INDEX CONCURRENTLY IF NOT EXISTS tvic_session_leases_generation_backfill_idx
  ON tvic_session_leases (expires_at_ms, session_id)
  WHERE generation_id IS NULL
    AND recovery_acknowledged_fence IS DISTINCT FROM fence;
`,
  },
  {
    version: 7,
    name: "007_recovery_candidate_index_concurrently.sql",
    sql: String.raw`CREATE INDEX CONCURRENTLY IF NOT EXISTS tvic_session_leases_recovery_expiry_idx
  ON tvic_session_leases (expires_at_ms, session_id)
  WHERE recovery_acknowledged_fence IS DISTINCT FROM fence;
`,
  },
  {
    version: 8,
    name: "008_drop_unfiltered_lease_expiry_index.sql",
    sql: String.raw`DROP INDEX CONCURRENTLY IF EXISTS tvic_session_leases_expiry_idx;
`,
  },
  {
    version: 9,
    name: "009_session_incarnation.sql",
    sql: String.raw`BEGIN;

CREATE SEQUENCE IF NOT EXISTS tvic_session_incarnation_seq AS bigint;

ALTER TABLE tvic_sessions
  ADD COLUMN IF NOT EXISTS incarnation bigint NOT NULL DEFAULT 0;

ALTER TABLE tvic_sessions
  ALTER COLUMN incarnation SET DEFAULT nextval('tvic_session_incarnation_seq');


ALTER TABLE tvic_outbox
  ADD COLUMN IF NOT EXISTS session_incarnation bigint NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION tvic_set_outbox_session_incarnation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_incarnation bigint;
BEGIN
  IF NEW.session_id IS NOT NULL AND NEW.session_incarnation = 0 THEN
    SELECT incarnation
      INTO current_incarnation
      FROM tvic_sessions
      WHERE id = NEW.session_id;
    IF FOUND THEN
      NEW.session_incarnation := current_incarnation;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tvic_outbox_session_incarnation_trigger ON tvic_outbox;
CREATE TRIGGER tvic_outbox_session_incarnation_trigger
  BEFORE INSERT ON tvic_outbox
  FOR EACH ROW
  EXECUTE FUNCTION tvic_set_outbox_session_incarnation();

COMMENT ON COLUMN tvic_sessions.incarnation IS
  'Session incarnation used to distinguish a reused session ID from an earlier session.';

COMMIT;
`,
  },
  {
    version: 10,
    name: "010_session_idempotency_lifetime.sql",
    sql: String.raw`BEGIN;

CREATE OR REPLACE FUNCTION tvic_clear_session_tool_idempotency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM tvic_tool_idempotency WHERE session_id = NEW.id;
  RETURN NEW;
END;
$$;


COMMIT;
`,
  },
  {
    version: 11,
    name: "011_tool_idempotency_session_index.sql",
    sql: String.raw`CREATE INDEX CONCURRENTLY IF NOT EXISTS tvic_tool_idempotency_session_id_idx
  ON tvic_tool_idempotency (session_id)
  WHERE session_id IS NOT NULL;
`,
  },
  {
    version: 12,
    name: "012_outbox_session_index.sql",
    sql: String.raw`CREATE INDEX CONCURRENTLY IF NOT EXISTS tvic_outbox_session_id_idx
  ON tvic_outbox (session_id);
`,
  },
  {
    version: 13,
    name: "013_outbox_delivered_retention_index.sql",
    sql: String.raw`CREATE INDEX CONCURRENTLY IF NOT EXISTS tvic_outbox_delivered_at_idx
  ON tvic_outbox (delivered_at)
  WHERE delivered_at IS NOT NULL;
`,
  },
  {
    version: 14,
    name: "014_guard_session_idempotency_lifetimes.sql",
    sql: String.raw`BEGIN;

CREATE OR REPLACE FUNCTION tvic_clear_session_tool_idempotency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.id, 0));
  DELETE FROM tvic_tool_idempotency WHERE session_id = NEW.id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tvic_session_tool_idempotency_trigger ON tvic_sessions;
CREATE TRIGGER tvic_session_tool_idempotency_trigger
  AFTER INSERT ON tvic_sessions
  FOR EACH ROW
  EXECUTE FUNCTION tvic_clear_session_tool_idempotency();

CREATE OR REPLACE FUNCTION tvic_guard_session_tool_idempotency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.session_id IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.session_id, 0));
  IF EXISTS (SELECT 1 FROM tvic_sessions WHERE id = NEW.session_id) THEN
    IF TG_OP = 'UPDATE' THEN
      IF OLD.session_id = NEW.session_id
         AND OLD.claimed_fence = NEW.claimed_fence
         AND OLD.claimed_generation_id IS NULL
         AND NEW.claimed_generation_id IS NULL
         AND EXISTS (
           SELECT 1
           FROM tvic_session_leases l
           WHERE l.session_id = NEW.session_id
             AND l.fence = NEW.claimed_fence
             AND l.expires_at_ms > floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
         ) THEN
        RETURN NEW;
      END IF;
    END IF;
    IF NOT EXISTS (
       SELECT 1
       FROM tvic_session_leases l
       WHERE l.session_id = NEW.session_id
         AND l.fence = NEW.claimed_fence
         AND l.generation_id::text = NEW.claimed_generation_id
         AND l.expires_at_ms > floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
    ) THEN
      RAISE EXCEPTION 'session-scoped idempotency writes require the current lease'
        USING ERRCODE = '23514',
              CONSTRAINT = 'tvic_tool_idempotency_current_session_lease';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tvic_tool_idempotency_session_lifetime_trigger
  ON tvic_tool_idempotency;
CREATE TRIGGER tvic_tool_idempotency_session_lifetime_trigger
  BEFORE INSERT OR UPDATE
  ON tvic_tool_idempotency
  FOR EACH ROW
  EXECUTE FUNCTION tvic_guard_session_tool_idempotency();

COMMIT;
`,
  },
  {
    version: 15,
    name: "015_terminal_session_retention_index.sql",
    sql: String.raw`CREATE INDEX CONCURRENTLY IF NOT EXISTS tvic_sessions_terminal_retention_idx
  ON tvic_sessions (ended_at, id)
  WHERE status IN ('completed', 'failed', 'cancelled');
`,
  },
  {
    version: 16,
    name: "016_outbox_delivered_retention_order_index.sql",
    sql: String.raw`CREATE INDEX CONCURRENTLY IF NOT EXISTS tvic_outbox_delivered_retention_idx
  ON tvic_outbox (delivered_at, id)
  WHERE delivered_at IS NOT NULL;
`,
  },
  {
    version: 17,
    name: "017_drop_outbox_delivered_at_index.sql",
    sql: String.raw`DROP INDEX CONCURRENTLY IF EXISTS tvic_outbox_delivered_at_idx;
`,
  },
  {
    version: 18,
    name: "018_require_idempotency_lease_context.sql",
    sql: String.raw`BEGIN;

CREATE OR REPLACE FUNCTION tvic_guard_session_tool_idempotency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  lease_context jsonb;
BEGIN
  IF NEW.session_id IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.session_id, 0));
  IF EXISTS (SELECT 1 FROM tvic_sessions WHERE id = NEW.session_id) THEN
    lease_context := NULLIF(
      current_setting('tvic.tool_idempotency_lease', true),
      ''
    )::jsonb;
    IF lease_context IS NULL
       OR lease_context->>'sessionId' IS DISTINCT FROM NEW.session_id
       OR lease_context->>'fence' IS DISTINCT FROM NEW.claimed_fence::text
       OR NOT EXISTS (
         SELECT 1
         FROM tvic_session_leases l
         WHERE l.session_id = NEW.session_id
           AND l.fence::text = lease_context->>'fence'
           AND l.generation_id::text = lease_context->>'generationId'
           AND l.expires_at_ms > floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
       )
       OR (
         NEW.claimed_generation_id IS NOT NULL
         AND lease_context->>'generationId' IS DISTINCT FROM NEW.claimed_generation_id
       ) THEN
      RAISE EXCEPTION 'session-scoped idempotency writes require the current lease context'
        USING ERRCODE = '23514',
              CONSTRAINT = 'tvic_tool_idempotency_current_session_lease';
    END IF;

    IF TG_OP = 'UPDATE' THEN
      IF OLD.session_id = NEW.session_id
         AND OLD.claimed_fence = NEW.claimed_fence
         AND OLD.claimed_generation_id IS NULL
         AND NEW.claimed_generation_id IS NULL
         AND EXISTS (
           SELECT 1
           FROM tvic_session_leases l
           WHERE l.session_id = NEW.session_id
             AND l.fence = NEW.claimed_fence
             AND l.expires_at_ms > floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
         ) THEN
        RETURN NEW;
      END IF;
    END IF;

    IF NOT EXISTS (
       SELECT 1
       FROM tvic_session_leases l
       WHERE l.session_id = NEW.session_id
         AND l.fence = NEW.claimed_fence
         AND l.generation_id::text = NEW.claimed_generation_id
         AND l.expires_at_ms > floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
    ) THEN
      RAISE EXCEPTION 'session-scoped idempotency writes require the current lease'
        USING ERRCODE = '23514',
              CONSTRAINT = 'tvic_tool_idempotency_current_session_lease';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
`,
  },
  {
    version: 19,
    name: "019_guard_idempotency_session_identity.sql",
    sql: String.raw`BEGIN;

CREATE OR REPLACE FUNCTION tvic_guard_tool_idempotency_session_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  now_ms bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
BEGIN
  IF OLD.session_id IS NOT NULL
     AND NEW.session_id IS DISTINCT FROM OLD.session_id
     AND OLD.expires_at_ms > now_ms
     AND EXISTS (SELECT 1 FROM tvic_sessions WHERE id = OLD.session_id) THEN
    RAISE EXCEPTION 'active session-scoped idempotency keys cannot change session identity'
      USING ERRCODE = '23514',
            CONSTRAINT = 'tvic_tool_idempotency_session_identity';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tvic_tool_idempotency_session_identity_trigger
  ON tvic_tool_idempotency;
CREATE TRIGGER tvic_tool_idempotency_session_identity_trigger
  BEFORE UPDATE OF session_id
  ON tvic_tool_idempotency
  FOR EACH ROW
  EXECUTE FUNCTION tvic_guard_tool_idempotency_session_identity();

COMMIT;
`,
  },
  {
    version: 21,
    name: "021_restore_outbox_session_incarnation_trigger.sql",
    sql: String.raw`BEGIN;

CREATE SEQUENCE IF NOT EXISTS tvic_session_incarnation_seq AS bigint;

ALTER TABLE tvic_sessions
  ADD COLUMN IF NOT EXISTS incarnation bigint NOT NULL DEFAULT 0;

ALTER TABLE tvic_sessions
  ALTER COLUMN incarnation SET DEFAULT nextval('tvic_session_incarnation_seq');

ALTER TABLE tvic_outbox
  ADD COLUMN IF NOT EXISTS session_incarnation bigint NOT NULL DEFAULT 0;

ALTER TABLE tvic_outbox
  ALTER COLUMN session_incarnation SET DEFAULT 0;

CREATE OR REPLACE FUNCTION tvic_set_outbox_session_incarnation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_incarnation bigint;
BEGIN
  IF NEW.session_id IS NOT NULL AND NEW.session_incarnation = 0 THEN
    SELECT incarnation
      INTO current_incarnation
      FROM tvic_sessions
      WHERE id = NEW.session_id;
    IF FOUND THEN
      NEW.session_incarnation := current_incarnation;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tvic_outbox_session_incarnation_trigger ON tvic_outbox;
CREATE TRIGGER tvic_outbox_session_incarnation_trigger
  BEFORE INSERT ON tvic_outbox
  FOR EACH ROW
  EXECUTE FUNCTION tvic_set_outbox_session_incarnation();

COMMIT;
`,
  },
] as const;
