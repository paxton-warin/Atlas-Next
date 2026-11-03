-- Check-Mail configuration and accounting stay separate from generic app settings.
CREATE TABLE check_mail_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  enabled boolean NOT NULL DEFAULT false,
  encrypted_api_key text,
  monthly_limit integer NOT NULL DEFAULT 1000 CHECK (monthly_limit BETWEEN 1 AND 1000),
  provider_remaining integer CHECK (provider_remaining >= 0),
  provider_observed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO check_mail_settings (id) VALUES (true);
CREATE TABLE check_mail_allowlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind varchar(16) NOT NULL CHECK (kind IN ('exact','domain','regex')),
  pattern text NOT NULL CHECK (length(pattern) BETWEEN 1 AND 320),
  enabled boolean NOT NULL DEFAULT true,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE check_mail_attempts (
  id uuid PRIMARY KEY,
  email_hash varchar(64) NOT NULL,
  outcome varchar(16) NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending','accepted','rejected','error')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX check_mail_attempts_created_at_idx ON check_mail_attempts (created_at);
CREATE TABLE check_mail_cache (
  email_hash varchar(64) PRIMARY KEY,
  attempt_id uuid NOT NULL REFERENCES check_mail_attempts(id),
  outcome varchar(16) NOT NULL CHECK (outcome IN ('pending','accepted','rejected','error')),
  expires_at timestamptz NOT NULL
);
