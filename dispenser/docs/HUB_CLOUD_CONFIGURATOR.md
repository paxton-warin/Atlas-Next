# Managed CloudFront configurator — implementation status

The Hub administrator panel queues immutable CloudFront operation plans. It never
executes a shell or AWS command in an HTTP request. Existing AWS scripts and local
profiles are untouched. Accounts are identified by a separately supplied,
STS-verified twelve-digit account ID, not by their friendly label.

## Local simulator

Run the Hub API with `HUB_CLOUD_FAKE=1` and the disposable lab database, then run:

```sh
HUB_CLOUD_FAKE=1 pnpm --filter @atlas-link-dispenser/server exec tsx src/hubCloudWorkerMain.ts
```

Use the same `DATABASE_URL` and encryption configuration as the local API. Fake
accounts sign in without AWS, and fixture distribution inventories are persisted
separately from checkpoints so worker restart does not create duplicates. The fake
adapter contains no executable and has no real-AWS fallback. Production rejects
fake-worker startup. Do not point the lab at a production database.

## Real adapter (not activated/rehearsed)

The separate worker uses AWS CLI v2, `login --remote` with an explicit region, and
an isolated generated profile. The authorization URL is displayed in the panel;
the returned code is encrypted in PostgreSQL, delivered only to child stdin, then
deleted. Existing ~/.aws configuration and ambient AWS\_\* environment variables are
never used. Each operation materializes private mode-0700 temporary directories,
mode-0600 files, and encrypts the CLI login cache at rest using the Hub encryption
key. Child output is parsed into allowlisted error codes; raw output is not logged.

Worker-specific configuration (deployment operator, never an end-user form):

- `HUB_CLOUD_AWS_EXECUTABLE`: installed AWS CLI absolute path; default `/usr/local/bin/aws`.
- `HUB_CLOUD_ORIGIN_KEY`: reviewed Atlas origin key for non-Hub distributions.
- `HUB_CLOUD_FAKE=1`: explicit non-production simulator only.

A newly issued login intentionally starts with a clean generated config to avoid
AWS CLI's overwrite-existing-login prompt. Existing working caches remain encrypted
until the newly signed-in identity has been verified successfully.

## Guaranteed staging behavior

The adapter checks actual target identity, inventories distributions, checks quotas,
groups viewer-request Functions by 100 distributions, and preserves resource IDs,
caller references, plan hashes, immutable plans and checkpoints across retries.
Plans support batches 1–5000 and individual existing-endpoint replacement. Existing
endpoint revision, AWS identity, CloudFront hostname and origin are verified before
provisioning replacements. Unrelated AWS resources are never changed.

Distribution creation uses HTTPS origins, all seven HTTP methods, disabled caching,
AllViewerExceptHostHeader, viewer-host/IP/protocol headers and WebSocket-capable
forwarding. New distributions remain unassigned while being qualified.

## Local activation and real-AWS release hold

A CloudFront `Deployed` response is **not** application acceptance. Real-AWS jobs
stop at `ready_for_activation`; no real deployment has been rehearsed or activated.

The explicit `NODE_ENV=test` / `HUB_CLOUD_FAKE=1` local lab can enable
`HUB_CLOUD_SIMULATION_AUTO_ACTIVATE=1`. This uses an isolated fixed-operation
coordinator and performs actual local branch/callback registration, health probes,
revision-checked link activation, Hub discovery and node endpoint updates. It
retains logical links, assignments and quotas. Durable encrypted activation
receipts recover a crash between database commit and routing acknowledgement.
Old frontend origins enter a trusted save/handoff state, not an immediate HTML
redirect; selected-node resources and WebSockets never receive a Hub-page redirect.
This path rejects production and contains no real-AWS fallback.

Local failure testing in the panel injects one narrowly enumerated fake-provider
failure: expired sign-in, wrong account, throttling, lost create acknowledgement,
stale revision or delayed deployment. It is absent for real-provider environments.
The next matching request consumes the failure atomically; retry reconciles the
separate fake resource inventory rather than creating a duplicate.

Required review and qualification before real activation:

1. Review runtime health/authentication/profile-write/WSS probes against the new endpoints.
2. Stage sync/handoff behavior at replaced browser origins; do not redirect unsynced saves.
3. Update `links.url` and `hub_branches.origin` atomically, retaining logical IDs and quotas,
   and invalidate/rotate old endpoint-bound handoffs and sessions appropriately.
4. Apply Hub discovery, OAuth callback and typed coordinator/node endpoint changes with
   cross-service revision checks; node traffic must never receive an HTML redirect.
5. Rehearse rollback, then explicitly authorize cutover. Old distributions remain enabled.
6. Complete the user's small two-account AWS rehearsal after the local walkthrough.

No AWS account login, distribution creation, production change, or real rehearsal
was performed while implementing this component.

## Replacement Hub account continuity

Migration `0017_hub_session_transfer.sql` adds a 60-second one-use ordinary-account
handoff between registered old/new revisions of the same logical Hub. A
host-only secure destination cookie binds a PKCE verifier and browser nonce;
the source page uses its existing Strict-cookie session and CSRF protection.
Source revocation/expiry and destination ownership are checked again during the
transactional exchange. The destination receives a fresh host-only session and
CSRF token, never the old cookie. Pending review/suspension and coordinator MFA
requirements are preserved. Explicit sign-out prevents automatic old-session
re-entry.

The local browser proof and its inspected captures are in Atlas-Next's
`evidence/hub-session-transfer`; ten real PostgreSQL tests cover transfer
boundaries and rollback. This does not qualify a real AWS callback or deployment.
Transition distributions remain enabled. An explicit reviewed retirement or AWS
deletion operation is not implemented; replacement never invokes deletion.
