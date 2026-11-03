-- Account/profile deletion removes its own chunk references as one cascading
-- statement. Normal chunk GC still rejects a live reference at statement end.
ALTER TABLE hub_profile_chunk_refs
 DROP CONSTRAINT hub_profile_chunk_refs_profile_id_hash_fkey;
ALTER TABLE hub_profile_chunk_refs
 ADD CONSTRAINT hub_profile_chunk_refs_profile_id_hash_fkey
 FOREIGN KEY(profile_id,hash) REFERENCES hub_chunks(profile_id,hash)
 ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE hub_profile_chunk_refs
 ADD CONSTRAINT hub_profile_chunk_refs_profile_fkey
 FOREIGN KEY(profile_id) REFERENCES hub_profiles(id) ON DELETE CASCADE;
