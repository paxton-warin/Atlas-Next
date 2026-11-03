-- Directories are supplied privately by the administrator, never bundled in source.
CREATE TABLE manual_verification_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain varchar(253) NOT NULL UNIQUE CHECK (domain = lower(domain)),
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE manual_verification_schools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id uuid NOT NULL REFERENCES manual_verification_domains(id) ON DELETE CASCADE,
  name varchar(200) NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(domain_id,name)
);
CREATE TABLE manual_verification_known_emails (
  school_id uuid NOT NULL REFERENCES manual_verification_schools(id) ON DELETE CASCADE,
  email varchar(320) NOT NULL CHECK (email = lower(email)),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(school_id,email)
);
CREATE INDEX manual_verification_known_email_idx ON manual_verification_known_emails(email,school_id);
CREATE TABLE manual_verification_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  domain varchar(253) NOT NULL,
  name varchar(160) NOT NULL,
  school_name varchar(200) NOT NULL,
  additional_information text NOT NULL CHECK (char_length(additional_information) <= 5000),
  status varchar(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  review_note varchar(1000) NOT NULL DEFAULT ''
);
CREATE INDEX manual_verification_requests_queue_idx ON manual_verification_requests(status,updated_at,id);
