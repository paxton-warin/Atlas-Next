-- Local simulator only; production routes and workers do not consume these.
CREATE TABLE hub_cloud_simulator_faults (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES hub_cloud_accounts(id),
 operation text NOT NULL CHECK(operation IN ('identity','quota','inventory','function','create','create_ack','inspect')),
 code text NOT NULL CHECK(code IN ('SIGN_IN_REQUIRED','AWS_ACCOUNT_MISMATCH','AWS_THROTTLED','AWS_TIMEOUT','AWS_REVISION_CONFLICT','AWS_DEPLOYING')),
 remaining integer NOT NULL DEFAULT 1 CHECK(remaining BETWEEN 0 AND 5),
 created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hub_cloud_simulator_faults_pending ON hub_cloud_simulator_faults(account_id,operation,created_at) WHERE remaining>0;
