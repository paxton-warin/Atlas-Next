CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TYPE role AS ENUM ('user', 'admin');
CREATE TYPE user_status AS ENUM ('active', 'suspended');
CREATE TYPE health_status AS ENUM ('healthy', 'degraded', 'unavailable', 'unknown', 'disabled');

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email varchar(320) NOT NULL,
  normalized_email varchar(320) NOT NULL UNIQUE, role role NOT NULL DEFAULT 'user',
  status user_status NOT NULL DEFAULT 'active', admin_notes text NOT NULL DEFAULT '',
  suspended_at timestamptz, suspension_reason text, quota_override jsonb,
  last_login_at timestamptz, verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash varchar(128) NOT NULL UNIQUE, csrf_hash varchar(128) NOT NULL,
  expires_at timestamptz NOT NULL, revoked_at timestamptz, ip varchar(64), user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_active_idx ON sessions(user_id, expires_at) WHERE revoked_at IS NULL;
CREATE TABLE verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email varchar(320) NOT NULL, code_hash varchar(128) NOT NULL,
  expires_at timestamptz NOT NULL, attempt_count integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL,
  used_at timestamptz, status varchar(32) NOT NULL DEFAULT 'pending', google_drive_file_id text,
  google_drive_permission_id text, request_ip varchar(64), cleanup_status varchar(32) NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verifications_email_created_idx ON verifications(email, created_at DESC);
CREATE TABLE email_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind varchar(16) NOT NULL CHECK (kind IN ('exact','domain','regex')),
  action varchar(8) NOT NULL CHECK (action IN ('allow','deny')), pattern text NOT NULL,
  priority integer NOT NULL, enabled boolean NOT NULL DEFAULT true, note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_rules_priority_idx ON email_rules(enabled, priority DESC);
CREATE TABLE links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name varchar(160) NOT NULL, url text NOT NULL UNIQUE,
  enabled boolean NOT NULL DEFAULT true, capacity integer CHECK (capacity IS NULL OR capacity > 0),
  weight integer NOT NULL DEFAULT 1 CHECK (weight BETWEEN 1 AND 10000),
  health_status health_status NOT NULL DEFAULT 'unknown', health_monitoring boolean NOT NULL DEFAULT true,
  consecutive_failures integer NOT NULL DEFAULT 0, consecutive_successes integer NOT NULL DEFAULT 0,
  expires_at timestamptz, notes text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE link_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  link_id uuid NOT NULL REFERENCES links(id) ON DELETE RESTRICT, active boolean NOT NULL DEFAULT true,
  assigned_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz, replaced_at timestamptz
);
CREATE UNIQUE INDEX assignments_one_active_per_user ON link_assignments(user_id) WHERE active;
CREATE INDEX assignments_link_active_idx ON link_assignments(link_id, active);
CREATE INDEX assignments_user_time_idx ON link_assignments(user_id, assigned_at DESC);
CREATE TABLE reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assignment_id uuid NOT NULL REFERENCES link_assignments(id) ON DELETE CASCADE,
  link_id uuid NOT NULL REFERENCES links(id) ON DELETE RESTRICT,
  category varchar(32) NOT NULL, detail text NOT NULL DEFAULT '', status varchar(16) NOT NULL DEFAULT 'open',
  admin_note text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reports_link_status_idx ON reports(link_id, status, created_at DESC);
CREATE TABLE app_settings (key varchar(100) PRIMARY KEY, value jsonb NOT NULL, updated_by uuid REFERENCES users(id) ON DELETE SET NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE audit_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), admin_id uuid REFERENCES users(id) ON DELETE SET NULL, action varchar(100) NOT NULL, target_type varchar(60) NOT NULL, target_id varchar(128), before jsonb, after jsonb, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX audit_events_time_idx ON audit_events(created_at DESC);
CREATE TABLE google_connections (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email varchar(320) NOT NULL, encrypted_tokens text NOT NULL, connected_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE health_checks (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), link_id uuid NOT NULL REFERENCES links(id) ON DELETE CASCADE, healthy boolean NOT NULL, status_code integer, duration_ms integer, error text, checked_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX health_checks_link_time_idx ON health_checks(link_id, checked_at DESC);

INSERT INTO app_settings (key, value) VALUES
('registration', '{"defaultMode":"allow","rateLimitPerHour":5}'),
('verification', '{"codeLength":6,"lifetimeMinutes":10,"maxAttempts":5,"resendCooldownSeconds":60}'),
('assignments', '{"strategy":"balanced_random","linksPerWeek":3,"assignmentLifetimeHours":168,"reassignmentCooldownMinutes":30}'),
('reporting', '{"duplicateCooldownMinutes":60}'),
('health', '{"enabled":true,"intervalMinutes":5,"timeoutSeconds":8,"path":"","failureThreshold":3,"successThreshold":2,"expectedStatuses":[200,201,202,204,301,302,307,308]}')
ON CONFLICT DO NOTHING;
