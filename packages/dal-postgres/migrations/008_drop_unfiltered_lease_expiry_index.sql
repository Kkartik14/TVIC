-- The filtered recovery index is ready before dropping the old unfiltered one.
DROP INDEX CONCURRENTLY IF EXISTS tvic_session_leases_expiry_idx;
