DROP INDEX IF EXISTS assignments_one_active_per_user;

CREATE TABLE denied_email_logins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email varchar(320) NOT NULL,
  matched_rule_id uuid REFERENCES email_rules(id) ON DELETE SET NULL,
  matched_rule_pattern text,
  decision_source varchar(32) NOT NULL,
  request_ip varchar(64),
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX denied_email_logins_email_time_idx ON denied_email_logins(email, created_at DESC);
CREATE INDEX denied_email_logins_created_idx ON denied_email_logins(created_at DESC);

UPDATE app_settings
SET value = (value - 'linksPerDay' - 'linksPerHour' - 'activeAssignments') || jsonb_build_object('linksPerWeek', COALESCE(value->'linksPerDay', '3'::jsonb))
WHERE key = 'assignments' AND NOT (value ? 'linksPerWeek');
