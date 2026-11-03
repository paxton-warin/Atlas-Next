-- Acknowledgements belong to the account and exact normalized document URL,
-- not an Atlas origin, browser session, or profile save. No URL content is stored.
CREATE TABLE hub_document_acknowledgements (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url_hash varchar(64) NOT NULL CHECK (url_hash ~ '^[0-9a-f]{64}$'),
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, url_hash)
);
