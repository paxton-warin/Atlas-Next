ALTER TABLE email_rules
  ADD COLUMN IF NOT EXISTS denial_message text NOT NULL DEFAULT '';
