-- One immutable global publication, not one notification row per account.
-- Share the existing numeric notification sequence so mixed clients may retain
-- their monotonic/BigInt cursor; UUIDs identify the announcement itself.
CREATE TABLE hub_announcements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 notification_id bigint NOT NULL UNIQUE DEFAULT nextval('hub_notifications_id_seq'),
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
 body text NOT NULL CHECK(length(body) BETWEEN 1 AND 5000),
 published_by uuid REFERENCES users(id) ON DELETE SET NULL,
 published_at timestamptz NOT NULL DEFAULT now(),
 withdrawn_at timestamptz,
 withdrawn_by uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX hub_announcements_active ON hub_announcements(notification_id DESC) WHERE withdrawn_at IS NULL;
CREATE TABLE hub_announcement_reads (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 announcement_id uuid NOT NULL REFERENCES hub_announcements(id) ON DELETE CASCADE,
 read_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,announcement_id)
);
