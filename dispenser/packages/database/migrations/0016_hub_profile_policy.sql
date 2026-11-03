-- Profile-byte policy is independent of link-generation quota.
CREATE TABLE hub_profile_policy_defaults (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 profile_bytes bigint NOT NULL DEFAULT 268435456 CHECK(profile_bytes BETWEEN 1048576 AND 8589934592),
 local_bytes bigint NOT NULL DEFAULT 5242880 CHECK(local_bytes BETWEEN 65536 AND 33554432),
 idb_bytes bigint NOT NULL DEFAULT 67108864 CHECK(idb_bytes BETWEEN 1048576 AND 1073741824),
 updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO hub_profile_policy_defaults(singleton) VALUES(true);
CREATE TABLE hub_profile_policy_overrides (
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 profile_bytes bigint CHECK(profile_bytes BETWEEN 1048576 AND 8589934592),
 local_bytes bigint CHECK(local_bytes BETWEEN 65536 AND 33554432),
 idb_bytes bigint CHECK(idb_bytes BETWEEN 1048576 AND 1073741824),
 updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE hub_profiles ADD COLUMN chunk_accounting_version smallint NOT NULL DEFAULT 0;
CREATE TABLE hub_profile_chunk_refs (
 profile_id uuid NOT NULL,
 hash varchar(64) NOT NULL,
 owner_kind text NOT NULL CHECK(owner_kind IN ('stream','commit','recovery')),
 owner_key text NOT NULL,
 PRIMARY KEY(profile_id,hash,owner_kind,owner_key),
 FOREIGN KEY(profile_id,hash) REFERENCES hub_chunks(profile_id,hash) ON DELETE RESTRICT
);
CREATE INDEX hub_profile_chunk_refs_owner ON hub_profile_chunk_refs(profile_id,owner_kind,owner_key);
CREATE INDEX hub_chunks_staging_age ON hub_chunks(profile_id,created_at);
