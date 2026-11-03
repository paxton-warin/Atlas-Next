-- Approved callback history permits a retired frontend to synchronize old data
-- without making arbitrary callback origins valid.
CREATE TABLE hub_branch_origins (
 branch_id uuid NOT NULL REFERENCES hub_branches(id) ON DELETE CASCADE,
 origin text NOT NULL, state text NOT NULL CHECK(state IN ('active','transition','retired')),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(branch_id,origin)
);
CREATE UNIQUE INDEX hub_branch_one_active_origin ON hub_branch_origins(branch_id) WHERE state='active';
INSERT INTO hub_branch_origins(branch_id,origin,state) SELECT id,origin,'active' FROM hub_branches;
CREATE TABLE hub_cloud_activation (
 job_id uuid PRIMARY KEY REFERENCES hub_cloud_jobs(id),
 phase text NOT NULL CHECK(phase IN ('prepared','database_committed','complete')),
 encrypted_payload text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE hub_cloud_branch_credentials (
 branch_id uuid PRIMARY KEY REFERENCES hub_branches(id) ON DELETE CASCADE,
 encrypted_secret text NOT NULL
);
CREATE TABLE hub_cloud_simulator_routes (
 origin text PRIMARY KEY, role text NOT NULL CHECK(role IN ('hub','frontend','node')),
 logical_id text NOT NULL, target_origin text, state text NOT NULL CHECK(state IN ('prepared','active','transition','retired')),
 revision integer NOT NULL DEFAULT 1, job_id uuid REFERENCES hub_cloud_jobs(id), updated_at timestamptz NOT NULL DEFAULT now()
);
