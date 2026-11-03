CREATE TABLE IF NOT EXISTS hub_ticket_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id bigint NOT NULL REFERENCES hub_ticket_messages(id) ON DELETE CASCADE,
  uploader_id uuid REFERENCES users(id) ON DELETE SET NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 180),
  mime_type text NOT NULL,
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 10485760),
  data bytea NOT NULL CHECK (octet_length(data) = byte_size),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hub_ticket_attachments_message ON hub_ticket_attachments(message_id);
CREATE INDEX IF NOT EXISTS hub_ticket_attachments_uploader ON hub_ticket_attachments(uploader_id) WHERE uploader_id IS NOT NULL;
