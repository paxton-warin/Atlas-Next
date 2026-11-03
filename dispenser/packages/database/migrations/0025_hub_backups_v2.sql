-- Separate replica backups. No v1 user data or receipts are removed or rewritten.
ALTER TABLE hub_profiles ADD COLUMN backup_v2_bytes bigint NOT NULL DEFAULT 0;
ALTER TABLE hub_profiles ADD CONSTRAINT backup_v2_bytes_bounded CHECK(backup_v2_bytes>=0) NOT VALID;
ALTER TABLE hub_profiles ADD COLUMN backup_v2_staging_bytes bigint NOT NULL DEFAULT 0;
ALTER TABLE hub_profiles ADD CONSTRAINT backup_v2_staging_bytes_bounded CHECK(backup_v2_staging_bytes>=0) NOT VALID;
ALTER TABLE hub_profiles ADD COLUMN backup_v2_migration_credit bigint NOT NULL DEFAULT 0;
ALTER TABLE hub_profiles ADD CONSTRAINT backup_v2_migration_credit_bounded CHECK(backup_v2_migration_credit>=0) NOT VALID;
ALTER TABLE hub_profiles ADD COLUMN backup_v1_staging_bytes bigint NOT NULL DEFAULT 0;
ALTER TABLE hub_profiles ADD CONSTRAINT backup_v1_staging_bytes_bounded CHECK(backup_v1_staging_bytes>=0) NOT VALID;
ALTER TABLE hub_profiles ADD COLUMN backup_v2_staging_parts bigint NOT NULL DEFAULT 0;
ALTER TABLE hub_profiles ADD CONSTRAINT backup_v2_staging_parts_bounded CHECK(backup_v2_staging_parts>=0) NOT VALID;
CREATE SEQUENCE hub_backup_publication_order;
CREATE TABLE hub_backup_replicas (
 profile_id uuid NOT NULL REFERENCES hub_profiles(id) ON DELETE CASCADE,
 replica_id uuid NOT NULL, incarnation uuid NOT NULL, branch_id uuid NOT NULL REFERENCES hub_branches(id),
 origin text NOT NULL,label varchar(80) NOT NULL,seed_checkpoint_id uuid,head_checkpoint_id uuid,
 head_sequence bigint NOT NULL DEFAULT 0 CHECK(head_sequence>=0),adopted_through bigint NOT NULL DEFAULT 0 CHECK(adopted_through>=0),
 deleted_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(profile_id,replica_id)
);
CREATE TABLE hub_backup_checkpoints (
 profile_id uuid NOT NULL,checkpoint_id uuid NOT NULL,replica_id uuid NOT NULL,sequence bigint NOT NULL CHECK(sequence>0),
 parent_checkpoint_id uuid,manifest_digest varchar(64) NOT NULL,manifest jsonb NOT NULL,
 status text NOT NULL DEFAULT 'prepared' CHECK(status IN ('prepared','complete','retired','expired')),
 publication_ordinal bigint,receipt jsonb,created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',history_day date,
 PRIMARY KEY(profile_id,checkpoint_id),
 FOREIGN KEY(profile_id,replica_id) REFERENCES hub_backup_replicas(profile_id,replica_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX hub_backup_sequence_identity ON hub_backup_checkpoints(profile_id,replica_id,sequence) WHERE status<>'expired';
CREATE UNIQUE INDEX hub_backup_one_prepared ON hub_backup_checkpoints(profile_id,replica_id) WHERE status='prepared';
CREATE INDEX hub_backup_completed_order ON hub_backup_checkpoints(profile_id,publication_ordinal DESC) WHERE status='complete';
CREATE TABLE hub_backup_namespace_versions (
 profile_id uuid NOT NULL,namespace_version_id uuid NOT NULL,checkpoint_id uuid NOT NULL,namespace text NOT NULL,
 parent_version_id uuid,kind text NOT NULL CHECK(kind IN ('baseline','delta','deleted')),local_cut bigint NOT NULL CHECK(local_cut>=0),
 schema_epoch text NOT NULL,root_digest varchar(64) NOT NULL,manifest jsonb NOT NULL,depth smallint NOT NULL DEFAULT 0 CHECK(depth BETWEEN 0 AND 16),
 PRIMARY KEY(profile_id,namespace_version_id),
 FOREIGN KEY(profile_id,checkpoint_id) REFERENCES hub_backup_checkpoints(profile_id,checkpoint_id) ON DELETE CASCADE,
 FOREIGN KEY(profile_id,parent_version_id) REFERENCES hub_backup_namespace_versions(profile_id,namespace_version_id) ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE
);
CREATE TABLE hub_backup_checkpoint_namespaces (
 profile_id uuid NOT NULL,checkpoint_id uuid NOT NULL,namespace text NOT NULL,namespace_version_id uuid NOT NULL,
 PRIMARY KEY(profile_id,checkpoint_id,namespace),
 FOREIGN KEY(profile_id,checkpoint_id) REFERENCES hub_backup_checkpoints(profile_id,checkpoint_id) ON DELETE CASCADE,
 FOREIGN KEY(profile_id,namespace_version_id) REFERENCES hub_backup_namespace_versions(profile_id,namespace_version_id) ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE
);
CREATE TABLE hub_backup_parts (
 profile_id uuid NOT NULL REFERENCES hub_profiles(id) ON DELETE CASCADE,hash varchar(64) NOT NULL,
 encrypted_payload bytea NOT NULL,bytes integer NOT NULL CHECK(bytes BETWEEN 1 AND 262144),
 published_refs bigint NOT NULL DEFAULT 0 CHECK(published_refs>=0),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(profile_id,hash)
);
CREATE TABLE hub_backup_checkpoint_parts (
 profile_id uuid NOT NULL,checkpoint_id uuid NOT NULL,hash varchar(64) NOT NULL,bytes integer NOT NULL CHECK(bytes BETWEEN 1 AND 262144),
 PRIMARY KEY(profile_id,checkpoint_id,hash),
 FOREIGN KEY(profile_id,checkpoint_id) REFERENCES hub_backup_checkpoints(profile_id,checkpoint_id) ON DELETE CASCADE
);
CREATE TABLE hub_backup_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),profile_id uuid NOT NULL REFERENCES hub_profiles(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('legacy-conversion','rollup','prune','reconcile')),namespace_version_id uuid,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','complete','deferred','error')),
 cursor jsonb,attempts integer NOT NULL DEFAULT 0,lease_expires_at timestamptz,error_code text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE hub_backup_migration_aliases (
 profile_id uuid NOT NULL REFERENCES hub_profiles(id) ON DELETE CASCADE,v1_namespace text NOT NULL,v1_revision bigint NOT NULL,
 namespace_version_id uuid NOT NULL,credit_bytes bigint NOT NULL CHECK(credit_bytes>=0),equivalent_bytes bigint NOT NULL DEFAULT 0 CHECK(equivalent_bytes>=0),source_valid boolean NOT NULL DEFAULT true,
 PRIMARY KEY(profile_id,v1_namespace,v1_revision),
 FOREIGN KEY(profile_id,namespace_version_id) REFERENCES hub_backup_namespace_versions(profile_id,namespace_version_id) ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE
);
-- Record indexes reference immutable bounded fragments; they do not duplicate plaintext data.
CREATE TABLE hub_backup_record_index (
 profile_id uuid NOT NULL,namespace_version_id uuid NOT NULL,record_id varchar(64) NOT NULL,
 store_name varchar(512) NOT NULL,store_epoch bigint NOT NULL DEFAULT 0 CHECK(store_epoch>=0),
 operation text NOT NULL CHECK(operation IN ('put','delete','clear-store','schema')),
 sha256 varchar(64) NOT NULL,total_bytes integer NOT NULL CHECK(total_bytes BETWEEN 1 AND 1048576),fragments jsonb NOT NULL,
 PRIMARY KEY(profile_id,namespace_version_id,record_id),
 FOREIGN KEY(profile_id,namespace_version_id) REFERENCES hub_backup_namespace_versions(profile_id,namespace_version_id) ON DELETE CASCADE
);
ALTER TABLE hub_backup_namespace_versions ADD COLUMN materialized_ready boolean NOT NULL DEFAULT false;
CREATE TABLE hub_backup_materialized_records (LIKE hub_backup_record_index INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
ALTER TABLE hub_backup_materialized_records ADD PRIMARY KEY(profile_id,namespace_version_id,record_id);
ALTER TABLE hub_backup_materialized_records ADD FOREIGN KEY(profile_id,namespace_version_id) REFERENCES hub_backup_namespace_versions(profile_id,namespace_version_id) ON DELETE CASCADE;
CREATE INDEX hub_backup_jobs_pending ON hub_backup_jobs(created_at,id) WHERE status IN ('pending','running');

CREATE INDEX hub_backup_unreferenced_parts ON hub_backup_parts(created_at,profile_id) WHERE published_refs=0;
CREATE INDEX hub_backup_prepared_expiry ON hub_backup_checkpoints(expires_at,profile_id) WHERE status='prepared';
-- Maintained compatibility counters make v1 accounting v2-aware without hot-path whole-account scans.
ALTER TABLE hub_chunks ADD COLUMN backup_reference_count bigint NOT NULL DEFAULT -1;
ALTER TABLE hub_chunks ADD CONSTRAINT backup_reference_count_bounded CHECK(backup_reference_count>=-1) NOT VALID;
ALTER TABLE hub_chunks ALTER COLUMN backup_reference_count SET DEFAULT 0;
ALTER TABLE hub_profiles ADD COLUMN backup_v1_canonical_bytes bigint NOT NULL DEFAULT 0;
ALTER TABLE hub_profiles ADD CONSTRAINT backup_v1_canonical_bytes_bounded CHECK(backup_v1_canonical_bytes>=0) NOT VALID;
ALTER TABLE hub_profiles ADD COLUMN backup_v1_staging_chunks bigint NOT NULL DEFAULT 0;
ALTER TABLE hub_profiles ADD CONSTRAINT backup_v1_staging_chunks_bounded CHECK(backup_v1_staging_chunks>=0) NOT VALID;
ALTER TABLE hub_profiles ADD COLUMN backup_accounting_version smallint NOT NULL DEFAULT 0;
ALTER TABLE hub_profiles ALTER COLUMN backup_accounting_version SET DEFAULT 1;
ALTER TABLE hub_profiles ADD COLUMN backup_accounting_epoch bigint NOT NULL DEFAULT 0;
CREATE INDEX hub_backup_accounting_pending ON hub_profiles(id) WHERE backup_accounting_version=0;
-- Existing rows are reconciled by128-row resumable maintenance slices, not migration-time scans.
CREATE FUNCTION hub_backup_v1_payload_delta() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pid uuid;delta bigint;accounting smallint;
BEGIN
 IF TG_OP='INSERT' THEN pid:=NEW.profile_id;delta:=NEW.bytes;
 ELSIF TG_OP='DELETE' THEN pid:=OLD.profile_id;delta:=-OLD.bytes;
 ELSE
  IF NEW.profile_id<>OLD.profile_id THEN RAISE EXCEPTION 'Profile payload identity is immutable'; END IF;
  pid:=NEW.profile_id;delta:=NEW.bytes-OLD.bytes;
 END IF;
 UPDATE hub_profiles SET backup_accounting_epoch=backup_accounting_epoch+1 WHERE id=pid RETURNING backup_accounting_version INTO accounting;
 IF accounting IS DISTINCT FROM 1 THEN RETURN NULL; END IF;
 IF delta<>0 THEN UPDATE hub_profiles SET backup_v1_canonical_bytes=backup_v1_canonical_bytes+delta WHERE id=pid; END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER hub_backup_v1_stream_delta AFTER INSERT OR UPDATE OF bytes OR DELETE ON hub_streams FOR EACH ROW EXECUTE FUNCTION hub_backup_v1_payload_delta();
CREATE TRIGGER hub_backup_v1_recovery_delta AFTER INSERT OR UPDATE OF bytes OR DELETE ON hub_profile_recoveries FOR EACH ROW EXECUTE FUNCTION hub_backup_v1_payload_delta();
CREATE FUNCTION hub_backup_v1_chunk_delta() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pid uuid;delta bigint;accounting smallint;count_delta integer;refs bigint;
BEGIN
 IF TG_OP='INSERT' THEN pid:=NEW.profile_id;delta:=NEW.bytes;count_delta:=1;refs:=NEW.backup_reference_count;
 ELSIF TG_OP='DELETE' THEN pid:=OLD.profile_id;delta:=-OLD.bytes;count_delta:=-1;refs:=OLD.backup_reference_count;
 ELSE
  IF NEW.profile_id<>OLD.profile_id OR NEW.hash<>OLD.hash THEN RAISE EXCEPTION 'Chunk identity is immutable'; END IF;
  pid:=NEW.profile_id;delta:=NEW.bytes-OLD.bytes;count_delta:=0;refs:=OLD.backup_reference_count;
 END IF;
 UPDATE hub_profiles SET backup_accounting_epoch=backup_accounting_epoch+1 WHERE id=pid RETURNING backup_accounting_version INTO accounting;
 IF accounting IS DISTINCT FROM 1 THEN RETURN NULL; END IF;
 IF refs>0 THEN UPDATE hub_profiles SET backup_v1_canonical_bytes=backup_v1_canonical_bytes+delta WHERE id=pid;
 ELSE UPDATE hub_profiles SET backup_v1_staging_bytes=backup_v1_staging_bytes+delta,backup_v1_staging_chunks=backup_v1_staging_chunks+count_delta WHERE id=pid;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER hub_backup_v1_chunk_delta AFTER INSERT OR UPDATE OF bytes OR DELETE ON hub_chunks FOR EACH ROW EXECUTE FUNCTION hub_backup_v1_chunk_delta();
CREATE FUNCTION hub_backup_v1_reference_delta() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE chunk_bytes bigint;new_refs bigint;target_profile uuid;target_hash text;accounting smallint;
BEGIN
 IF TG_OP='UPDATE' AND (NEW.profile_id<>OLD.profile_id OR NEW.hash<>OLD.hash) THEN RAISE EXCEPTION 'Reference chunk identity is immutable'; END IF;
 IF TG_OP='UPDATE' THEN RETURN NULL; END IF;
 IF TG_OP='INSERT' THEN
  target_profile:=NEW.profile_id;target_hash:=NEW.hash;
  UPDATE hub_chunks SET backup_reference_count=backup_reference_count+1 WHERE profile_id=target_profile AND hash=target_hash AND backup_reference_count>=0 RETURNING hub_chunks.bytes,backup_reference_count INTO chunk_bytes,new_refs;
  UPDATE hub_profiles SET backup_accounting_epoch=backup_accounting_epoch+1 WHERE id=target_profile RETURNING backup_accounting_version INTO accounting;
  IF accounting=1 AND new_refs=1 THEN UPDATE hub_profiles SET backup_v1_canonical_bytes=backup_v1_canonical_bytes+chunk_bytes,backup_v1_staging_bytes=backup_v1_staging_bytes-chunk_bytes,backup_v1_staging_chunks=backup_v1_staging_chunks-1 WHERE id=target_profile; END IF;
 ELSE
  target_profile:=OLD.profile_id;target_hash:=OLD.hash;
  UPDATE hub_chunks SET backup_reference_count=backup_reference_count-1 WHERE profile_id=target_profile AND hash=target_hash AND backup_reference_count>=0 RETURNING hub_chunks.bytes,backup_reference_count INTO chunk_bytes,new_refs;
  UPDATE hub_profiles SET backup_accounting_epoch=backup_accounting_epoch+1 WHERE id=target_profile RETURNING backup_accounting_version INTO accounting;
  IF accounting=1 AND new_refs=0 THEN UPDATE hub_profiles SET backup_v1_canonical_bytes=backup_v1_canonical_bytes-chunk_bytes,backup_v1_staging_bytes=backup_v1_staging_bytes+chunk_bytes,backup_v1_staging_chunks=backup_v1_staging_chunks+1 WHERE id=target_profile; END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER hub_backup_v1_reference_delta AFTER INSERT OR UPDATE OR DELETE ON hub_profile_chunk_refs FOR EACH ROW EXECUTE FUNCTION hub_backup_v1_reference_delta();
-- Conversion jobs pin completed immutable source identities, never reinterpret a live journal.
ALTER TABLE hub_backup_jobs ADD COLUMN source jsonb;
ALTER TABLE hub_backup_jobs ADD COLUMN result jsonb;
ALTER TABLE hub_backup_jobs ADD COLUMN owner_token uuid;
CREATE UNIQUE INDEX hub_backup_one_legacy_converter ON hub_backup_jobs(kind) WHERE kind='legacy-conversion' AND status='running';
ALTER TABLE hub_chunks ADD COLUMN backup_conversion_pins integer NOT NULL DEFAULT 0;
ALTER TABLE hub_chunks ADD CONSTRAINT backup_conversion_pins_bounded CHECK(backup_conversion_pins>=0) NOT VALID;
CREATE TABLE hub_backup_legacy_chunk_pins (
 profile_id uuid NOT NULL,job_id uuid NOT NULL REFERENCES hub_backup_jobs(id) ON DELETE CASCADE,hash varchar(64) NOT NULL,
 PRIMARY KEY(profile_id,job_id,hash),FOREIGN KEY(profile_id,hash) REFERENCES hub_chunks(profile_id,hash) ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE
);
CREATE FUNCTION hub_backup_conversion_pin_delta() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN UPDATE hub_chunks SET backup_conversion_pins=backup_conversion_pins+1 WHERE profile_id=NEW.profile_id AND hash=NEW.hash;
 ELSE UPDATE hub_chunks SET backup_conversion_pins=backup_conversion_pins-1 WHERE profile_id=OLD.profile_id AND hash=OLD.hash; END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER hub_backup_conversion_pin_delta AFTER INSERT OR DELETE ON hub_backup_legacy_chunk_pins FOR EACH ROW EXECUTE FUNCTION hub_backup_conversion_pin_delta();
-- Equivalence credit exists only while the exact completed legacy source remains unchanged.
CREATE FUNCTION hub_backup_revoke_conversion_credit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE released bigint;
BEGIN
 IF TG_OP='UPDATE' AND NEW.revision=OLD.revision AND NEW.snapshot_revision=OLD.snapshot_revision AND NEW.encrypted_payload IS NOT DISTINCT FROM OLD.encrypted_payload THEN RETURN NULL; END IF;
 SELECT COALESCE(sum(credit_bytes),0) INTO released FROM hub_backup_migration_aliases WHERE profile_id=OLD.profile_id AND v1_namespace=OLD.namespace;
 UPDATE hub_backup_migration_aliases SET credit_bytes=0,source_valid=false WHERE profile_id=OLD.profile_id AND v1_namespace=OLD.namespace;
 IF released>0 THEN
  UPDATE hub_profiles SET backup_v2_migration_credit=backup_v2_migration_credit-released,bytes=backup_v1_canonical_bytes+GREATEST(0,backup_v2_bytes-backup_v2_migration_credit+released) WHERE id=OLD.profile_id;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER hub_backup_revoke_conversion_credit AFTER UPDATE OF revision,snapshot_revision,encrypted_payload OR DELETE ON hub_streams FOR EACH ROW EXECUTE FUNCTION hub_backup_revoke_conversion_credit();

CREATE UNIQUE INDEX hub_backup_one_conversion_per_profile ON hub_backup_jobs(profile_id) WHERE kind='legacy-conversion' AND status IN ('pending','running');

ALTER TABLE hub_profiles ADD COLUMN backup_conversion_staging_bytes bigint NOT NULL DEFAULT 0;
ALTER TABLE hub_profiles ADD CONSTRAINT backup_conversion_staging_bytes_bounded CHECK(backup_conversion_staging_bytes>=0) NOT VALID;
ALTER TABLE hub_backup_replicas ADD COLUMN adopted_checkpoint_id uuid;
ALTER TABLE hub_backup_replicas ADD COLUMN adopted_manifest_digest varchar(64);

ALTER TABLE hub_backup_namespace_versions ADD COLUMN delta_bytes bigint NOT NULL DEFAULT 0 CHECK(delta_bytes>=0);
