-- The session-insert trigger removes prior-lifetime results by session ID.
-- Build this index concurrently because the idempotency table may be populated.
CREATE INDEX CONCURRENTLY IF NOT EXISTS tvic_tool_idempotency_session_id_idx
  ON tvic_tool_idempotency (session_id)
  WHERE session_id IS NOT NULL;
