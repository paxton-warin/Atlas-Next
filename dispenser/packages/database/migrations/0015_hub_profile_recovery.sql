CREATE TABLE hub_profile_recoveries (
 id uuid PRIMARY KEY, profile_id uuid NOT NULL REFERENCES hub_profiles(id) ON DELETE CASCADE,
 context_id text NOT NULL, namespace text NOT NULL, encrypted_payload text NOT NULL,
 payload_hash text NOT NULL, bytes bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hub_profile_recoveries_profile ON hub_profile_recoveries(profile_id,created_at);
