-- Managed CloudFront operations. Existing logical links/assignments are retained.
CREATE TABLE hub_cloud_accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), label varchar(120) NOT NULL,
 expected_account_id char(12) NOT NULL CHECK(expected_account_id ~ '^[0-9]{12}$'),
 verified_account_id char(12), region varchar(40) NOT NULL DEFAULT 'us-east-1',
 status text NOT NULL DEFAULT 'sign_in_required' CHECK(status IN ('sign_in_required','pending','connected','error')),
 encrypted_cache text, created_by uuid REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(), verified_at timestamptz
);
CREATE TABLE hub_cloud_login (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES hub_cloud_accounts(id),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','waiting_code','code_submitted','complete','expired','error')),
 authorization_url text, encrypted_code text, error_code varchar(80), worker_owner uuid, worker_lease timestamptz,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX hub_cloud_login_one_active ON hub_cloud_login(account_id) WHERE status IN ('queued','waiting_code','code_submitted');
CREATE TABLE hub_cloud_endpoints (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), role text NOT NULL CHECK(role IN ('hub','frontend','node')),
 logical_id text NOT NULL, link_id uuid REFERENCES links(id), account_id uuid NOT NULL REFERENCES hub_cloud_accounts(id),
 distribution_id varchar(64) NOT NULL, url text NOT NULL, origin_host varchar(253) NOT NULL,
 revision integer NOT NULL DEFAULT 1, state text NOT NULL DEFAULT 'active' CHECK(state IN ('staged','active','transition','retired')),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(account_id,distribution_id)
);
CREATE UNIQUE INDEX hub_cloud_endpoint_active ON hub_cloud_endpoints(role,logical_id) WHERE state='active';
CREATE TABLE hub_cloud_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), plan jsonb NOT NULL, plan_hash char(64) NOT NULL,
 state text NOT NULL DEFAULT 'preview' CHECK(state IN ('preview','queued','running','waiting','sign_in_required','ready_for_activation','complete','failed','cancelled')),
 revision integer NOT NULL DEFAULT 0, checkpoint jsonb NOT NULL DEFAULT '{}',
 error_code varchar(80), created_by uuid REFERENCES users(id), approved_by uuid REFERENCES users(id),
 lease_owner uuid, lease_until timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hub_cloud_jobs_pending ON hub_cloud_jobs(state,updated_at);
CREATE TABLE hub_cloud_events (
 id bigserial PRIMARY KEY, job_id uuid REFERENCES hub_cloud_jobs(id) ON DELETE CASCADE,
 stage varchar(80) NOT NULL, code varchar(80), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION hub_cloud_immutable_plan() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.plan IS DISTINCT FROM OLD.plan OR NEW.plan_hash IS DISTINCT FROM OLD.plan_hash THEN
   RAISE EXCEPTION 'Cloud operation plans are immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER hub_cloud_plan_immutable BEFORE UPDATE ON hub_cloud_jobs FOR EACH ROW EXECUTE FUNCTION hub_cloud_immutable_plan();
-- Simulator state is deliberately separate from job checkpoints so ambiguous
-- create responses and worker restarts can be rehearsed without real AWS.
CREATE TABLE hub_cloud_simulator_resources (
 account_id uuid NOT NULL REFERENCES hub_cloud_accounts(id), id text NOT NULL,
 resource jsonb NOT NULL, PRIMARY KEY(account_id,id)
);
CREATE TABLE hub_cloud_simulator_functions (
 account_id uuid NOT NULL REFERENCES hub_cloud_accounts(id), name text NOT NULL,
 arn text NOT NULL, PRIMARY KEY(account_id,name)
);
