ALTER TABLE hub_handoffs ADD COLUMN callback_origin text;
CREATE TABLE hub_writer_handoffs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES hub_profiles(id) ON DELETE CASCADE,
 site_group text NOT NULL, owner_context text NOT NULL, owner_epoch bigint NOT NULL,
 requester_session uuid NOT NULL REFERENCES hub_branch_sessions(id), requester_context text NOT NULL,
 status text NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting','ready','used')),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '2 minutes', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hub_writer_pending ON hub_writer_handoffs(profile_id,owner_context,status);
