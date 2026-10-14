CREATE INDEX CONCURRENTLY IF NOT EXISTS tvic_tool_idempotency_session_id_idx
  ON tvic_tool_idempotency (session_id)
  WHERE session_id IS NOT NULL;
