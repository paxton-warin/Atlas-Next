# Combined Hub local laboratory

Start the isolated application and the local AWS simulator:

```sh
node scripts/hub-lab.mjs start
```

The command builds both sibling repositories, initializes **only** the marked
local `atlas_hub_lab_test` PostgreSQL database, then starts the real Hub app,
fake AWS worker, account-gated opaque Atlas runtime, Main runtime, Nodes 2–4, local
website fixtures, and loopback HTTPS/WSS proxies. Node and dependencies must be
installed in both repositories. PostgreSQL and Redis must already be running
locally; it does not install or reconfigure system services.

Default connections:

- PostgreSQL: current OS user, localhost:5432, `atlas_hub_lab_test`.
- Redis: localhost:56379, database 14; every key also has a unique lab prefix.
- Override with `ATLAS_LAB_DATABASE_URL` / `ATLAS_LAB_REDIS_URL` only within the
  same exact local database constraints. Remote addresses and query options fail.

The launcher never reads repository `.env` files or inherits AWS credentials or
production database settings. It never calls AWS. Existing AWS profiles, Atlas
production databases, and the normal 4180 browser-test fixture are untouched.
Generated keys, TLS files, process IDs, and logs stay in a private temporary
lab directory, printed after startup. Certificates are self-signed and local;
no system certificate trust is changed.

## Walk through

1. Run `node scripts/hub-lab.mjs status` and open its current **hub** URL; accept only this local certificate warning. The original URL is https://localhost:4300, but simulated replacements change it.
2. Sign in as **student@atlas-lab.example** or **admin@atlas-lab.example**.
3. Follow **Open your verification file**, then enter the code from the local
   fixture. The normal request/verify APIs, sessions, CSRF, and access rules run;
   no Google or email-provider requests are made.
4. Open the student's Latest link. The initial address is https://localhost:4280; after a simulated replacement use the current **atlas** URL from `status`.
5. In administration, open **Infrastructure**. The old/new accounts are
   explicitly labeled local fixtures. Preview a configurable batch, approve it,
   and observe the worker staging resources. No real CloudFront operations run.

The local worker applies real logical endpoint revisions and branch registrations to
this disposable stack. New simulated frontend aliases use
`*.atlas.localhost:4280`; Hub aliases use port 4300 and node aliases retain their
selected node's port. HTTPS and WSS are served by loopback proxies. A completed
simulator operation means local routing was activated, **not** that AWS or
production was changed. The separate real-AWS worker still holds activation for
the required rehearsal and deployment gates.

Approved old/new Hub endpoints support ordinary account-session carryover. On the
replacement Hub, a signed-out browser briefly visits the approved old Hub, then
exchanges a one-use destination/browser-bound authorization code for a fresh
host-only session. The old session cookie is not copied or placed in a URL.
Explicit Sign out suppresses automatic restoration. Pending-verification and
suspended account state remains unchanged; transfer does not grant browsing or
coordinator MFA.

`status` reads current Hub/frontend revisions from the marked lab database after
replacement. It does not continue advertising the original transition endpoints.

The deterministic website fixture is at **http://fixture.localhost:4299**. It has
an editable draft, explicit localStorage counter save, IndexedDB records with
Blob/typed-array data and auto-increment keys, transaction abort, cookies, module
imports, classic/module workers, a nested frame, popup, fetch, and a generated
WAV media probe. Fixture DNS and access to this nonstandard loopback port are
enabled only by test-mode fixture settings; production ignores those overrides.

Use `/storage` for isolated save/cookie/worker checks. The separately
qualified generic HTTP(S) nested-frame adapter uses document-bound ports. This route excludes the iframe
element explicitly; it does not qualify frame compatibility. `/` and `/frames`
keep the complete fixture, including the nested iframe, so a frame bootstrap
failure remains visible rather than being hidden in the acceptance results.
The frontend's Main `/relay/*` traffic goes to the Main runtime. Trusted storage
and cookie-owner sockets remain on the frontend application.

## Browser evidence

```sh
node scripts/hub-lab-walkthrough.mjs
```

This uses installed Google Chrome, normal sign-in against the local verification
provider, and the real administrator form/queue. It verifies authorization and
profile initialization, persistent explicit sign-out, then creates and activates
101 local simulated distributions. It records synthetic screenshots and results
under `evidence/hub-lab-local`; no cookies, authorization codes, storage-state
files, or credentials are exported. This walkthrough mutates only the lab.

`hub-profile-walkthrough.mjs` and `hub-profile-crosshost.mjs` exercise the actual
opaque runtime and encrypted Hub profile transport. Their recorded results are
separate from the earlier held-runtime screenshots: old captures are historical,
not proof of a qualified current browser. The complete simulation still requires
the bounded integrated proofs listed in the candidate status; production gates
remain separate.

It captures desktop, mobile, welcome, preview, and staged views. It checks mobile
horizontal overflow. For stable full-page captures it resets scroll and waits for
fonts/layout; mobile administration is captured in a fresh page before loading.
It is a targeted walkthrough, not the complete final release screenshot matrix.

## Targeted operation and UI evidence

- `node scripts/hub-cloud-walkthrough.mjs`: administrator panel fault/recovery
  walkthrough using only the local fake provider. `--capture-only` does not
  provision another batch.
- `node scripts/hub-ui-review.mjs`: task-led ordinary-user sign-in, browsing,
  tabs, Support, Your saves, sign-out and responsive captures. Findings and
  recaptures are under `evidence/hub-ui-review`.
- `node scripts/hub-session-transfer-walkthrough.mjs`: ordinary old-Hub sign-in,
  automatic replacement-Hub carryover, then explicit sign-out/reload. Results and
  opened screenshot review are under `evidence/hub-session-transfer`.
- `node scripts/hub-account-simulation.mjs --long-outage --features`: normal
  A→B→A sign-in, isolated saves, a 95-second profile-sync API outage, acknowledged recovery,
  history clearing, nested frames, workers, IndexedDB, media and an opaque popup.
  Identity and frontend/native-owner APIs remain reachable in that probe. It
  does not qualify complete Hub downtime or synchronous saving with the whole
  browser network offline. Repeated synthetic runs share one loopback IP and can
  hit the ordinary browsing-request limit. The integrated harness logs a 65-second
  pause between its account-switch and feature workloads; it does not reset or
  raise that limit. The optional-popup429 regression separately proves a rejected
  spare reservation does not strand an ordinary document. Real shared-IP load
  and request-budget sizing remain production acceptance work.
- `node scripts/hub-support-sse-walkthrough.mjs`: public reply/unread state,
  live notifications, visible conversation reads and reconnect/poll recovery.
- `hub-cloud-replacement-walkthrough.mjs --execute-local-replacements` is an
  explicit, state-changing local three-endpoint replacement. Its original
  targets have already been replaced in the current lab: do not rerun it blindly.
  `evidence/hub-cloud-replacement` preserves the reviewed operation, actual
  activation receipt, old frontend save/handoff and node non-redirect checks.

Local transition endpoints remain enabled to allow outstanding saves to finish.
Explicit retire/disable/delete operations are not exposed by this simulator;
no cleanup is performed implicitly when a replacement completes.

## Lifecycle

```sh
node scripts/hub-lab.mjs status
node scripts/hub-lab.mjs stop
node scripts/hub-lab.mjs start --skip-build
node scripts/hub-lab.mjs reset
```

`stop` signals only processes whose command line contains this lab's private
state marker. `reset` additionally verifies the database marker, then drops only
`atlas_hub_lab_test` and removes private lab files. It does not flush Redis or
remove production data. Ordinary stop/start retains the lab data.

Native local dependencies are deliberate in this first launcher: no Docker
engine is currently required. Real-AWS rehearsal is a separate, not-yet-run
step after local walkthrough approval and must never be enabled as simulator
fallback.

## Current review result

The account-switch journey records eight passing tasks in
`evidence/hub-account-local/account-results.json`. A final-runtime rich browsing
journey records four passing tasks in
`evidence/hub-popup-bootstrap/targeted-ui/account-results.json`, including actual
frontend reload after acknowledged localStorage/cookie saves. Both have no page
JavaScript errors. The real cancellation regressions additionally cover sixty
in-flight cancellations while an independent request continues normally.

Use `node scripts/hub-account-simulation.mjs --integrated-probe` for the shorter
normal-sign-in rich browsing/reload journey. The complete account journey remains
`node scripts/hub-account-simulation.mjs --features`; `--long-outage` adds the
95-second profile-sync API fault. These scripts use synthetic accounts and only
the marked disposable lab. Intermediate failures remain in evidence rather than
being approved as new successful baselines.
