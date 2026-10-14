CREATE INDEX CONCURRENTLY IF NOT EXISTS tvic_outbox_session_id_idx
  ON tvic_outbox (session_id);
