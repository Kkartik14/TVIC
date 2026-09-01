BEGIN;

-- The JSON payload is the durable domain record. Keep the indexed lifecycle
-- columns in sync for installations that were written before adapters updated
-- those columns on aggregate transitions; retention relies on ended_at.
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
