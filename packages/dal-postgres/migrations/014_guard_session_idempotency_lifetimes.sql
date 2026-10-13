BEGIN;

-- Keep compatibility operations on a missing session ID serialized with
-- session creation, and reject unfenced writes once that ID has an active life.
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
