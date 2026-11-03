-- A manifest is small even when its encrypted chunks expand to many MiB.
-- Bound the complete snapshot+journal restore, not just JSON manifest bytes.
-- NULL means an existing stream needs authenticated lazy accounting.
ALTER TABLE hub_streams ADD COLUMN restore_bytes bigint CHECK(restore_bytes>=0);
