ALTER TABLE users ADD COLUMN quota_reset_at timestamptz;
CREATE INDEX health_checks_recent_idx ON health_checks(checked_at DESC);
