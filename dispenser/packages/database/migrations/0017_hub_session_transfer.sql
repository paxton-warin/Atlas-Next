-- Destination/browser-bound account-session transfer between approved Hub revisions.
CREATE TABLE hub_session_transfers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 source_origin text NOT NULL,
 destination_origin text NOT NULL,
 return_to text NOT NULL,
 pkce_challenge varchar(128) NOT NULL,
 browser_hash varchar(128) NOT NULL,
 source_session_id uuid REFERENCES sessions(id) ON DELETE CASCADE,
 user_id uuid REFERENCES users(id) ON DELETE CASCADE,
 code_hash varchar(128) UNIQUE,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','authorized','consumed','failed')),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '60 seconds',
 created_at timestamptz NOT NULL DEFAULT now(),
 consumed_at timestamptz,
 CHECK(source_origin<>destination_origin)
);
CREATE INDEX hub_session_transfers_expiry_idx ON hub_session_transfers(expires_at);
