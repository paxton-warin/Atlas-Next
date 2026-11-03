CREATE TABLE IF NOT EXISTS hub_tickets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES users(id) ON DELETE CASCADE,
 subject text NOT NULL, category text NOT NULL, status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','awaiting_you','closed')),
 legacy_source text, legacy_id text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(legacy_source,legacy_id)
);
CREATE TABLE IF NOT EXISTS hub_ticket_messages (
 id bigserial PRIMARY KEY, ticket_id uuid NOT NULL REFERENCES hub_tickets(id) ON DELETE CASCADE,
 author text NOT NULL CHECK(author IN ('user','admin')), body text NOT NULL, public boolean NOT NULL DEFAULT true,
 legacy_message_id text, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(ticket_id,legacy_message_id)
);
CREATE TABLE IF NOT EXISTS hub_ticket_reads (
 ticket_id uuid NOT NULL REFERENCES hub_tickets(id) ON DELETE CASCADE, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 message_id bigint NOT NULL DEFAULT 0, PRIMARY KEY(ticket_id,user_id)
);
CREATE TABLE IF NOT EXISTS hub_notifications (
 id bigserial PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 ticket_id uuid NOT NULL REFERENCES hub_tickets(id) ON DELETE CASCADE, message_id bigint NOT NULL UNIQUE REFERENCES hub_ticket_messages(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(), read_at timestamptz
);
CREATE INDEX IF NOT EXISTS hub_notifications_owner ON hub_notifications(user_id,id DESC);
CREATE TABLE IF NOT EXISTS hub_metric_sources (
 id text PRIMARY KEY, observed_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
 account_ids uuid[] NOT NULL DEFAULT '{}', presence_verified boolean NOT NULL DEFAULT false, complete boolean NOT NULL DEFAULT false, payload jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS hub_metric_points (
 bucket timestamptz NOT NULL, resolution integer NOT NULL CHECK(resolution IN (15,300,3600)),
 scope text NOT NULL, metric text NOT NULL, value double precision NOT NULL, minimum double precision NOT NULL, maximum double precision NOT NULL, samples bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(bucket,resolution,scope,metric)
);
CREATE INDEX IF NOT EXISTS hub_metric_points_query ON hub_metric_points(metric,scope,bucket);
