-- Additive immutable catalog preparation. No historical payload or whole-table UPDATE.
ALTER TABLE hub_backup_checkpoints ADD COLUMN catalog_version smallint NOT NULL DEFAULT 0;
ALTER TABLE hub_backup_checkpoints ADD COLUMN catalog_ready boolean NOT NULL DEFAULT false;
ALTER TABLE hub_backup_checkpoints ADD COLUMN catalog_count integer NOT NULL DEFAULT 0;
ALTER TABLE hub_backup_checkpoints ADD COLUMN catalog_digest varchar(64);
ALTER TABLE hub_backup_checkpoints ADD COLUMN catalog_cursor jsonb;
ALTER TABLE hub_backup_checkpoints ADD COLUMN catalog_released boolean NOT NULL DEFAULT false;
ALTER TABLE hub_backup_checkpoints ADD CONSTRAINT backup_catalog_count_bounded CHECK(catalog_count BETWEEN 0 AND 1024) NOT VALID;
ALTER TABLE hub_backup_checkpoint_parts ADD COLUMN ref_held boolean NOT NULL DEFAULT false;
ALTER TABLE hub_backup_namespace_versions ADD COLUMN parts_ready boolean NOT NULL DEFAULT false;
ALTER TABLE hub_backup_namespace_versions ADD COLUMN parts_cursor varchar(64);
CREATE TABLE hub_backup_namespace_parts (
 profile_id uuid NOT NULL,namespace_version_id uuid NOT NULL,hash varchar(64) NOT NULL,bytes integer NOT NULL CHECK(bytes BETWEEN 1 AND 262144),
 PRIMARY KEY(profile_id,namespace_version_id,hash),
 FOREIGN KEY(profile_id,namespace_version_id) REFERENCES hub_backup_namespace_versions(profile_id,namespace_version_id) ON DELETE CASCADE
);
CREATE TABLE hub_backup_catalog_pins (
 profile_id uuid NOT NULL,owner_checkpoint_id uuid NOT NULL,parent_checkpoint_id uuid NOT NULL,
 PRIMARY KEY(profile_id,owner_checkpoint_id),
 FOREIGN KEY(profile_id,owner_checkpoint_id) REFERENCES hub_backup_checkpoints(profile_id,checkpoint_id) ON DELETE CASCADE,
 FOREIGN KEY(profile_id,parent_checkpoint_id) REFERENCES hub_backup_checkpoints(profile_id,checkpoint_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX hub_backup_catalog_parent_pin ON hub_backup_catalog_pins(profile_id,parent_checkpoint_id);
ALTER TABLE hub_backup_jobs ADD COLUMN last_served_at timestamptz NOT NULL DEFAULT '-infinity';
CREATE TABLE hub_backup_maintenance_schedule(category text PRIMARY KEY,last_served_at timestamptz NOT NULL DEFAULT '-infinity',turn bigint NOT NULL DEFAULT 0);
INSERT INTO hub_backup_maintenance_schedule(category) VALUES('rollup'),('gc'),('accounting');
CREATE TABLE hub_backup_maintenance_profiles (
 profile_id uuid PRIMARY KEY REFERENCES hub_profiles(id) ON DELETE CASCADE,
 rollup_served_at timestamptz NOT NULL DEFAULT '-infinity',gc_served_at timestamptz NOT NULL DEFAULT '-infinity',accounting_served_at timestamptz NOT NULL DEFAULT '-infinity'
);
ALTER TABLE hub_backup_maintenance_profiles ADD COLUMN gc_lease_expires_at timestamptz;
ALTER TABLE hub_backup_maintenance_profiles ADD COLUMN gc_owner_token uuid;
ALTER TABLE hub_backup_maintenance_profiles ADD COLUMN accounting_lease_expires_at timestamptz;
ALTER TABLE hub_backup_maintenance_profiles ADD COLUMN accounting_owner_token uuid;
CREATE TABLE hub_backup_catalog_pages (
 profile_id uuid NOT NULL REFERENCES hub_profiles(id) ON DELETE CASCADE,page_id uuid NOT NULL,
 digest varchar(64) NOT NULL,entry_count smallint NOT NULL CHECK(entry_count BETWEEN 1 AND 64),
 lower_key text NOT NULL,upper_key text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(profile_id,page_id)
);
CREATE TABLE hub_backup_catalog_entries (
 profile_id uuid NOT NULL,page_id uuid NOT NULL,namespace text NOT NULL,namespace_version_id uuid NOT NULL,
 PRIMARY KEY(profile_id,page_id,namespace),
 FOREIGN KEY(profile_id,page_id) REFERENCES hub_backup_catalog_pages(profile_id,page_id) ON DELETE CASCADE,
 FOREIGN KEY(profile_id,namespace_version_id) REFERENCES hub_backup_namespace_versions(profile_id,namespace_version_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE hub_backup_catalog_root_pages (
 profile_id uuid NOT NULL,checkpoint_id uuid NOT NULL,ordinal smallint NOT NULL CHECK(ordinal BETWEEN 0 AND 31),page_id uuid NOT NULL,
 PRIMARY KEY(profile_id,checkpoint_id,ordinal),UNIQUE(profile_id,checkpoint_id,page_id),
 FOREIGN KEY(profile_id,checkpoint_id) REFERENCES hub_backup_checkpoints(profile_id,checkpoint_id) ON DELETE CASCADE,
 FOREIGN KEY(profile_id,page_id) REFERENCES hub_backup_catalog_pages(profile_id,page_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);
CREATE VIEW hub_backup_catalog_namespace_refs AS
 SELECT x.profile_id,x.checkpoint_id,x.namespace,x.namespace_version_id
 FROM hub_backup_checkpoint_namespaces x JOIN hub_backup_checkpoints c USING(profile_id,checkpoint_id) WHERE c.catalog_version=0
 UNION ALL
 SELECT r.profile_id,r.checkpoint_id,e.namespace,e.namespace_version_id
 FROM hub_backup_catalog_root_pages r JOIN hub_backup_catalog_entries e USING(profile_id,page_id);
CREATE INDEX hub_backup_catalog_entries_version ON hub_backup_catalog_entries(profile_id,namespace_version_id);
CREATE INDEX hub_backup_catalog_root_page_refs ON hub_backup_catalog_root_pages(profile_id,page_id);

ALTER TABLE hub_backup_catalog_root_pages ADD FOREIGN KEY(profile_id) REFERENCES hub_profiles(id) ON DELETE CASCADE;
ALTER TABLE hub_backup_catalog_pins ADD FOREIGN KEY(profile_id) REFERENCES hub_profiles(id) ON DELETE CASCADE;
ALTER TABLE hub_backup_namespace_parts ADD FOREIGN KEY(profile_id) REFERENCES hub_profiles(id) ON DELETE CASCADE;
CREATE TABLE hub_backup_rollup_sources (
 profile_id uuid NOT NULL REFERENCES hub_profiles(id) ON DELETE CASCADE,job_id uuid NOT NULL REFERENCES hub_backup_jobs(id) ON DELETE CASCADE,
 namespace_version_id uuid NOT NULL,source_form text NOT NULL CHECK(source_form IN ('index','materialized')),depth smallint NOT NULL CHECK(depth BETWEEN 0 AND 16),
 PRIMARY KEY(job_id,namespace_version_id),FOREIGN KEY(profile_id,namespace_version_id) REFERENCES hub_backup_namespace_versions(profile_id,namespace_version_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX hub_backup_rollup_source_pins ON hub_backup_rollup_sources(profile_id,namespace_version_id);
CREATE TABLE hub_backup_rollup_epochs (
 profile_id uuid NOT NULL REFERENCES hub_profiles(id) ON DELETE CASCADE,job_id uuid NOT NULL REFERENCES hub_backup_jobs(id) ON DELETE CASCADE,
 store_name text NOT NULL,store_epoch bigint NOT NULL CHECK(store_epoch>=0),PRIMARY KEY(job_id,store_name)
);
CREATE TABLE hub_backup_restore_pins (
 profile_id uuid NOT NULL REFERENCES hub_profiles(id) ON DELETE CASCADE,checkpoint_id uuid NOT NULL,reader_id varchar(64) NOT NULL,expires_at timestamptz NOT NULL,
 PRIMARY KEY(profile_id,checkpoint_id,reader_id),
 FOREIGN KEY(profile_id,checkpoint_id) REFERENCES hub_backup_checkpoints(profile_id,checkpoint_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX hub_backup_restore_pins_expiry ON hub_backup_restore_pins(expires_at,profile_id);
CREATE TABLE hub_backup_cancellations (
 profile_id uuid NOT NULL REFERENCES hub_profiles(id) ON DELETE CASCADE,checkpoint_id uuid NOT NULL,replica_id uuid NOT NULL,manifest_digest varchar(64) NOT NULL,
 sequence bigint NOT NULL CHECK(sequence>0),parent_checkpoint_id uuid,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(profile_id,checkpoint_id),
 FOREIGN KEY(profile_id,replica_id) REFERENCES hub_backup_replicas(profile_id,replica_id) ON DELETE CASCADE
);
CREATE INDEX hub_backup_cancellations_replica ON hub_backup_cancellations(profile_id,replica_id,sequence);
ALTER TABLE hub_backup_replicas ADD COLUMN last_cancel_checkpoint_id uuid;
ALTER TABLE hub_backup_replicas ADD COLUMN last_cancel_manifest_digest varchar(64);
ALTER TABLE hub_backup_replicas ADD COLUMN last_cancel_sequence bigint;
ALTER TABLE hub_backup_replicas ADD COLUMN last_cancel_parent_checkpoint_id uuid;
CREATE INDEX hub_backup_restore_owner ON hub_backup_restore_pins(profile_id,reader_id,expires_at);
CREATE INDEX hub_backup_restore_profile_expiry ON hub_backup_restore_pins(profile_id,expires_at);
ALTER TABLE hub_backup_restore_pins ADD COLUMN lease_id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE hub_backup_parts ADD COLUMN ever_published boolean NOT NULL DEFAULT false;
ALTER TABLE hub_backup_parts ADD COLUMN gc_eligible_at timestamptz;
ALTER TABLE hub_backup_restore_pins ADD COLUMN legacy boolean NOT NULL DEFAULT false;
ALTER TABLE hub_backup_restore_pins DROP CONSTRAINT hub_backup_restore_pins_pkey;
ALTER TABLE hub_backup_restore_pins ADD PRIMARY KEY(profile_id,checkpoint_id,reader_id,lease_id);
ALTER TABLE hub_backup_checkpoints ADD COLUMN replacement_proof jsonb;
-- The explicit additive runner records the exact SQL identity in the same COMMIT.
-- This new empty table adds no scan or rewrite to historical profile tables.
CREATE TABLE hub_backup_migration_receipts (
 id text PRIMARY KEY,source_sha256 varchar(64) NOT NULL CHECK(source_sha256 ~ '^[a-f0-9]{64}$'),applied_at timestamptz NOT NULL DEFAULT now()
);
