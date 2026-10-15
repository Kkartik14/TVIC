BEGIN;

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
