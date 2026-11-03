# Test commands and coverage boundaries

## Default local checks

```sh
pnpm workspace:check
pnpm typecheck:all
pnpm test:all
pnpm build:all
pnpm test:browser
```

The first four commands use the root orchestration interface and the existing
component dependency graphs. They do not deploy or start database services.
Native browser tests create disposable loopback application/network fixtures.
Keep their local prerequisites separate from production credentials and data.
Normal report output is under `test-results/`.

Hub's default Vitest suite intentionally gates database cases on an explicit
`TEST_DATABASE_URL`. The November 3 repository cleanup's default run passed
1,776 Main tests and 359 Hub tests; 420 Hub database-gated tests were skipped.
Those skipped cases are not passing database coverage. The normal native-Chrome
run completed 228 rows: 225 passes, two existing annotated upstream download
failures and one explicitly gated live-CDN skip, with zero unexpected failures.

## Database-enabled qualification

Use a new, disposable loopback PostgreSQL database whose name ends `_test`, and
an independently isolated Redis instance where the selected suite requires it.
Several suites enforce this requirement themselves. Never use a live database.

`pnpm test:hub-tools` explicitly runs the bootstrap tool's database integration
tests. It is not part of default `test:all` because it requires a dedicated test
PostgreSQL connection and performs fixture migrations inside isolated schemas.

During this cleanup, a temporary local PostgreSQL **16.14** cluster was used for:

- Eight focused migration/SQL-writer fixture tests: passed.
- Four bootstrap-tool integration tests: passed.
- Seventeen native-browser/full-stack and maintenance cases after report-path
  repairs: passed.

These are real local PostgreSQL/Chrome checks, not a PostgreSQL 17 production or
real-account acceptance claim. All owned test services were stopped afterward.

### Existing full-database-suite failures

The optional complete server run with PostgreSQL/Redis reported **572 passing,
62 failing tests**, plus a generated-report-directory teardown error. The report
path was repaired and its full-stack/maintenance cases rerun successfully.

The remaining failures are older expectations for retired legacy profile/v1
synchronization behavior: account locks, identity profiles, compaction, profile
policy, skip-sync and V2 legacy conversion scenarios. Current routes return
`410 PROFILE_LEGACY_SYNC_RETIRED` where those older tests expect successful legacy
writes. One unchanged failing case was independently rerun; both its test source
and the retirement implementation matched the pre-cleanup hashes exactly.

The repository cleanup does not re-enable retired synchronization, weaken its
retirement gate, remove those tests or relabel them as passing. The legacy test
expectations need a separate behavior/test-contract review. Default-suite success
must not be described as a fully passing database-enabled suite.

## Migration fixture provenance

The old pre-catalog Hub HTTP implementation was referenced from a deleted audit
snapshot and was not available in the retained Git/archive objects. It was not
silently replaced by today's implementation.

`dispenser/apps/server/src/catalogZeroWriter.fixture.ts` is explicitly newly
authored. It exercises only the pre-0026 SQL writer columns, before and after the
additive migration, checking catalog defaults and namespace visibility. It proves
that bounded SQL schema contract, not historical HTTP/authentication/quota binary
compatibility. Its tests are tracked, self-contained and do not require audit
output under `evidence/`.

## Optional tools

`tools/README.md` categorizes opt-in diagnostics and the exact relocation map.
Pure mocked tool tests can be run explicitly; do not execute every operator or
real-network diagnostic as part of an automated repository check. Dated legacy
tools are not current deployment instructions.

Private per-command logs, input hashes and copy-only rollback receipts from the
cleanup are retained locally under `local-retained/cleanup-20261103/`; no live
production test or deployment is implied by those local checks.
