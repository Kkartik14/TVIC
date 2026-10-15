BEGIN;

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
