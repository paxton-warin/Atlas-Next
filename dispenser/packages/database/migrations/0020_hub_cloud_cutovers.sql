-- Explicit production cutover receipts. No existing account/profile/link data
-- changes when applying this migration; provisioning jobs remain immutable.
CREATE TABLE hub_cloud_cutovers (
 job_id uuid PRIMARY KEY REFERENCES hub_cloud_jobs(id),
 id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
 phase text NOT NULL DEFAULT 'prepared' CHECK(phase IN ('prepared','database_committed','complete')),
 prepared_job_revision integer NOT NULL CHECK(prepared_job_revision>=0),
 plan_hash char(64) NOT NULL CHECK(plan_hash ~ '^[a-f0-9]{64}$'),
 checkpoint_hash char(64) NOT NULL CHECK(checkpoint_hash ~ '^[a-f0-9]{64}$'),
 asset_manifest_hash char(64) NOT NULL CHECK(asset_manifest_hash ~ '^[a-f0-9]{64}$'),
 binding_hash char(64) NOT NULL CHECK(binding_hash ~ '^[a-f0-9]{64}$'),
 operator_id uuid NOT NULL REFERENCES users(id),
 encrypted_payload text NOT NULL,
 staged_at timestamptz,
 acceptance_hash char(64), encrypted_acceptance text, acceptance_key_hash char(64),
 database_committed_at timestamptz, completed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((acceptance_hash IS NULL AND encrypted_acceptance IS NULL AND acceptance_key_hash IS NULL) OR
       (acceptance_hash ~ '^[a-f0-9]{64}$' AND encrypted_acceptance IS NOT NULL AND acceptance_key_hash ~ '^[a-f0-9]{64}$')),
 CHECK(phase='prepared' OR (acceptance_hash IS NOT NULL AND database_committed_at IS NOT NULL)),
 CHECK(phase<>'complete' OR completed_at IS NOT NULL)
);
CREATE TABLE hub_cloud_cutover_targets (
 job_id uuid NOT NULL REFERENCES hub_cloud_cutovers(job_id),
 role text NOT NULL CHECK(role IN ('hub','frontend','node')),
 logical_id text NOT NULL, released boolean NOT NULL DEFAULT false,
 PRIMARY KEY(job_id,role,logical_id)
);
CREATE UNIQUE INDEX hub_cloud_cutover_one_pending_target
 ON hub_cloud_cutover_targets(role,logical_id) WHERE NOT released;
CREATE FUNCTION hub_cloud_cutover_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.job_id,NEW.id,NEW.prepared_job_revision,NEW.plan_hash,NEW.checkpoint_hash,NEW.asset_manifest_hash,NEW.binding_hash,NEW.operator_id,NEW.encrypted_payload)
  IS DISTINCT FROM ROW(OLD.job_id,OLD.id,OLD.prepared_job_revision,OLD.plan_hash,OLD.checkpoint_hash,OLD.asset_manifest_hash,OLD.binding_hash,OLD.operator_id,OLD.encrypted_payload) THEN
  RAISE EXCEPTION 'Cutover bindings are immutable';
 END IF;
 IF OLD.acceptance_hash IS NOT NULL AND ROW(NEW.acceptance_hash,NEW.encrypted_acceptance,NEW.acceptance_key_hash)
  IS DISTINCT FROM ROW(OLD.acceptance_hash,OLD.encrypted_acceptance,OLD.acceptance_key_hash) THEN
  RAISE EXCEPTION 'Runtime acceptance is immutable';
 END IF;
 IF NOT (NEW.phase=OLD.phase OR OLD.phase='prepared' AND NEW.phase='database_committed' OR OLD.phase='database_committed' AND NEW.phase='complete') THEN
  RAISE EXCEPTION 'Cutover phase cannot move backwards';
 END IF;
 IF OLD.staged_at IS NOT NULL AND NEW.staged_at IS DISTINCT FROM OLD.staged_at THEN
  RAISE EXCEPTION 'Registry staging acknowledgement is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER hub_cloud_cutover_immutable BEFORE UPDATE ON hub_cloud_cutovers
 FOR EACH ROW EXECUTE FUNCTION hub_cloud_cutover_immutable();
CREATE FUNCTION hub_cloud_cutover_job_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p text;
BEGIN
 SELECT phase INTO p FROM hub_cloud_cutovers WHERE job_id=OLD.id;
 IF p IS NOT NULL AND NEW.checkpoint IS DISTINCT FROM OLD.checkpoint THEN
  RAISE EXCEPTION 'A prepared cutover checkpoint is immutable';
 END IF;
 IF p='database_committed' AND NEW.state NOT IN ('running','complete') THEN
  RAISE EXCEPTION 'A committed cutover must finish its durable coordinator operation';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER hub_cloud_cutover_job_guard BEFORE UPDATE ON hub_cloud_jobs
 FOR EACH ROW EXECUTE FUNCTION hub_cloud_cutover_job_guard();
