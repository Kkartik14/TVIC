-- Retention deletes delivered outbox rows by delivery time.
-- Build the index concurrently because this table can be populated at deployment.
CREATE INDEX CONCURRENTLY IF NOT EXISTS tvic_outbox_delivered_at_idx
  ON tvic_outbox (delivered_at)
  WHERE delivered_at IS NOT NULL;
