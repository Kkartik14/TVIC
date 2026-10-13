-- Retention checks and the session foreign key both look up outbox rows by session.
-- Build the index concurrently because this table can be populated at deployment.
CREATE INDEX CONCURRENTLY IF NOT EXISTS tvic_outbox_session_id_idx
  ON tvic_outbox (session_id);
