# Atlas Hub combined local candidate

Candidate: `hub-2026.10.20-local.2` · **local simulation; production held**.

Both repositories remain separate. The opt-in local laboratory runs the real Hub,
Atlas, Main and Nodes2–4, PostgreSQL, Redis, opaque browsing runtime and an explicit
fake AWS worker. The production runtime manifest remains `activated:false`. No
production service, real AWS resource, existing VPS volume or production database
has been changed. Discord and game detection remain deferred.

## Working integrated paths

- Normal Hub verification → destination/browser-bound one-use authorization code
  → host-only account branch session. Eligibility and revocation are checked on
  browsing, relay and profile APIs. Explicit sign-out does not automatically sign
  back in. Profile/account changes discard old in-flight responses.
- Account-scoped native localStorage, IndexedDB and rewritten cookies use exact
  logical website namespaces. Data and the durable upload journal commit in the
  same native transaction; remote success requires an explicit matching receipt.
  Cloud hydration precedes website execution. Allowlisted Atlas preferences use
  per-key compare-and-set updates and independent window IDs, not transport keys.
- The actual cross-host browser proof restores Count7, an IndexedDB record with
  Blob/typed-array data, schema/key-generator state, and a session cookie. Native
  CDP checks report opaque origin `null` and denied parent DOM/native storage/IDB.
  Flush-before-takeover is exercised, rather than forced last-write-wins.
- The local reviewed operation replaced one active frontend, the Hub and Node2.
  Logical IDs, assignments, quotas and nine untargeted peers stayed unchanged.
  The old browser quiesced/synchronized before reaching the replacement Hub.
  Normal new-Hub reauthentication restored the same LS/IDB/cookie data; another
  record continued the generated key at2. This is a local routing proof, not AWS.
- Account support, capability-based legacy claims, durable public-reply unread
  notifications, visible conversation read acknowledgements, central coordinator
  MFA, real account-to-live-relay CCU and four-node historical metrics have actual
  local walkthrough evidence. Monitoring gaps remain unknown, not fabricated0s.
- The configurator previews immutable multi-account jobs, invokes a private
  fixed-argv worker, resumes six tested failure modes, and activates local
  revisions. Tests cover batches1/100/101/250; the simulator has no real-AWS
  fallback. Automatic destructive distribution cleanup is not enabled.
- The recognizable dark/green shell has a56px condensed rail,44px tab targets,
  active markers/counts, previews, pinning, search, close/undo and reorder controls
  that preserve mounted frames/forms. Mobile navigation and tab drawers are
  labeled. Experimental page isolation and Page options stay removed.
- Admin global/per-account profile limits default to5MiB localStorage,64MiB IDB
  per origin and256MiB canonical profile data. Bounded staged chunks have24-hour
  grace and authenticated reference-aware collection; active refs and commit
  receipts survive repeated checkpoint replacement and collection tests.
- Native IndexedDB now accounts actual logical bytes across databases, rather
  than dividing the origin quota into8MiB slices. A63MiB single-database probe,
  concurrent growth, crash recovery and lower-policy reads/shrinks/deletes pass.
  The portable codec separately bounds decoded data at64MiB and encoded replay
  at128MiB, so binary base64 expansion is not confused with native quota usage.
- Support replies push account-bound invalidations over protected SSE, with
  durable unread state and polling/reconnect recovery. Replacement Hub session
  carryover uses a one-use browser/destination-bound exchange; explicit sign-out
  remains signed out. Both have normal-UI local walkthrough evidence.

These are bounded observed paths, not a claim that the full release gates pass.
Tests, screenshots and historical failures are kept separately under `evidence/`.

## Local walkthrough delivered

The actual browser results are under `evidence/hub-account-local` (eight passing
tasks) and `evidence/hub-popup-bootstrap/targeted-ui` (four passing tasks against
the final runtime). Fresh screenshots were opened and independently inspected.
The latter includes a popup, native localStorage and cookie writes, explicit
remote acknowledgement, and an actual frontend reload preserving both saves.

Two reproduced reliability defects were corrected rather than hidden by reload
loops: a rejected optional popup reservation stranded required frame startup,
and a cancelled HTTP request could receive late headers after its request handle
was cleared. The instance adapter now gates terminal callbacks and reconciles
only the exact request's bookkeeping after native removal. Thirty real response-
race cancellations and thirty held-response cancellations each preserve a peer
request and settle all request maps/counters to zero with the event loop stopped.
The pinned vendor bundle remains unchanged.

This is a runnable local simulation for review. It is not a production rollout or
a claim that the open release gates below have passed.

## Explicit open release gates

1. **Full browser-network-offline synchronous saves:** the current synchronous
   localStorage/cookie acknowledgement depends on a reachable frontend marker.
   A reserved-scope service worker does not make Chromium synchronous XHR work
   offline and does not control opaque documents. The runtime throws before an
   unacknowledgeable mutation and retains previously saved data. A profile-sync API
   outage with frontend/native-owner and identity services still reachable is a
   different case, not proof of this gate.
   Do not replace this with an asynchronous mirror or weaken browser isolation.
2. **Compatibility:** general nested HTTP(S) frames now have document-bound ports
   and native opaque-denial tests. Linked popup navigation/reload and inherited/
   inline child contexts need their own qualification. The final integrated
   module/worker/media/pop-up walkthrough is recorded separately from lower-level
   tests. Old real-site ChatGPT/Gmail/ESPN+
   results do not qualify the new architecture; current site checks remain open.
3. **Profile lifecycle:** pinned pagination restores beyond1000 entries, but
   automatic compaction before the128MiB encoded replay bound remains open.
   Complete conflict/recovery UI, offline superseded-writer
   recovery, concurrent contexts and first-import races require final acceptance.
   Passing targeted quota/codec/native tests alone does not close these gates.
4. **Identity/operations:** explicit reviewed resource retirement, multi-window
   revocation and the remaining long-lived session cases need final acceptance.
   Local Hub carryover and pushed notification reconnect are now exercised, not
   missing implementations. Shared-IP request-budget sizing also needs real load
   qualification; the rapid local workload is paced without weakening limits.
5. **Final production acceptance:** the local account-switch/profile-API-outage/
   metadata journey passes eight checks. After the final request-accounting fix,
   the rich module/worker/IDB/media/popup/save/reload journey passes four checks
   with no page errors. These are bounded local proofs, not the complete real-site,
   long-lived-session, concurrency and accessibility acceptance matrix. Source
   packaging and copy-only rollback receipts are recorded separately.
6. **Deferred after local walkthrough:** two-account real-AWS/tunnel rehearsal
   (seven distributions maximum), deployment backups/images/key protection,
   operational rollback, complete-package canary and fleet rollout.

## Run and inspect

```sh
node scripts/hub-lab.mjs start
node scripts/hub-lab.mjs status
# Use the current Hub/Atlas URLs printed by status; replacements change them.
node scripts/hub-lab.mjs stop
```

See [local laboratory](HUB_LOCAL_LAB.md) for prerequisites and synthetic accounts.
PostgreSQL/Redis/dependencies must already be installed. Only marked disposable
lab data is seeded. No credentials/cookies/storage-state files are retained in
public evidence. The launcher uses private temporary files and self-signed local
TLS, without modifying system trust or existing AWS profiles.

Useful checks:

```sh
node scripts/sync-hub-contracts.mjs --check
pnpm typecheck
node --test tests/*.test.mjs
node tests/profile-store-browser.mjs
node tests/profile-journal-browser.mjs
node tests/profile-sync-browser.mjs
node scripts/hub-account-simulation.mjs
pnpm exec playwright test
```

Run full Node tests separately from `tests/serve.mjs`: both have a fixture on4199.
Review [the independent audit](../evidence/hub-combined-20261020/SIMULATION_GAPS.md)
and its dated follow-ups; earlier findings and holding-screen captures are
historical evidence, not silently approved current baselines.
