-- Hub is opt-in. This migration adds separate records without altering legacy data.
CREATE TABLE hub_branches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 link_id uuid NOT NULL UNIQUE REFERENCES links(id) ON DELETE RESTRICT,
 origin text NOT NULL UNIQUE,
 secret_hash varchar(64) NOT NULL,
 enabled boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE hub_profiles (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
 encrypted_key text NOT NULL,
 initialized boolean NOT NULL DEFAULT false,
 revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
 bytes bigint NOT NULL DEFAULT 0 CHECK(bytes>=0),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE hub_handoffs (
 code_hash varchar(64) PRIMARY KEY,
 branch_id uuid NOT NULL REFERENCES hub_branches(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 parent_session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 challenge varchar(43) NOT NULL,
 state varchar(128) NOT NULL,
 expires_at timestamptz NOT NULL,
 used_at timestamptz
);
CREATE TABLE hub_branch_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 profile_id uuid NOT NULL REFERENCES hub_profiles(id) ON DELETE CASCADE,
 branch_id uuid NOT NULL REFERENCES hub_branches(id) ON DELETE CASCADE,
 parent_session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 token_hash varchar(64) NOT NULL UNIQUE,
 context_id varchar(96) NOT NULL,
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hub_branch_sessions_user ON hub_branch_sessions(user_id,created_at);
CREATE TABLE hub_writers (
 profile_id uuid NOT NULL REFERENCES hub_profiles(id) ON DELETE CASCADE,
 site_group varchar(253) NOT NULL,
 session_id uuid NOT NULL REFERENCES hub_branch_sessions(id) ON DELETE CASCADE,
 context_id varchar(96) NOT NULL,
 epoch bigint NOT NULL DEFAULT 1 CHECK(epoch>0),
 expires_at timestamptz NOT NULL,
 PRIMARY KEY(profile_id,site_group)
);
CREATE TABLE hub_streams (
 profile_id uuid NOT NULL REFERENCES hub_profiles(id) ON DELETE CASCADE,
 namespace text NOT NULL,
 revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
 encrypted_payload text,
 bytes integer NOT NULL DEFAULT 0 CHECK(bytes>=0),
 snapshot_revision bigint NOT NULL DEFAULT 0,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(profile_id,namespace)
);
CREATE TABLE hub_commits (
 profile_id uuid NOT NULL REFERENCES hub_profiles(id) ON DELETE CASCADE,
 idempotency_key varchar(96) NOT NULL,
 namespace text NOT NULL,
 payload_hash varchar(64) NOT NULL,
 mode varchar(16) NOT NULL CHECK(mode IN ('snapshot','journal')),
 encrypted_payload text,
 bytes integer NOT NULL DEFAULT 0,
 revision bigint NOT NULL,
 profile_revision bigint NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(profile_id,idempotency_key)
);
CREATE TABLE hub_chunks (
 profile_id uuid NOT NULL REFERENCES hub_profiles(id) ON DELETE CASCADE,
 hash varchar(64) NOT NULL,
 encrypted_payload text NOT NULL,
 bytes integer NOT NULL CHECK(bytes>=0 AND bytes<=4194304),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(profile_id,hash)
);
CREATE TABLE hub_imports (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 profile_id uuid NOT NULL REFERENCES hub_profiles(id) ON DELETE CASCADE,
 session_id uuid NOT NULL REFERENCES hub_branch_sessions(id) ON DELETE CASCADE,
 context_id varchar(96) NOT NULL,
 status varchar(16) NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved','committed','cancelled')),
 expires_at timestamptz NOT NULL,
 manifest_hash varchar(64),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX hub_import_single_reserved ON hub_imports(profile_id) WHERE status='reserved';
