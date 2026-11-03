# One repository, two deployed components

The browser/Main/node application and the Hub/link dispenser are ordinary source
in this repository. `dispenser/` has no nested Git repository or submodule. The
older separately checked-out projects are not development dependencies.

## Stable boundaries

Application source paths and services remain where the existing builds and
operators expect them. Root browser commands retain their prior behavior; the
root `*:all` commands orchestrate both components. A repository merge does not
mean merging database schemas, authentication authorities, server processes,
container images or production volumes.

`server/`, `runtime/` and `web/` own browser/Main/node business code.
`dispenser/apps/` and `dispenser/packages/` own Hub business code/contracts.
Do not remove a runtime module merely because its name contains `sandbox`,
`opaque` or `legacy`: these names can describe required compatibility paths.

## Dependency policy

`pnpm-lock.yaml` is the browser dependency graph.
`dispenser/pnpm-lock.yaml` is the Hub dependency graph.

They are deliberately separate **within one Git repository**, not separate
repositories. Nine identical package/version identities in the old graphs choose
different transitive resolutions. A naive shared-lock merge would change one
component's installed dependencies. This cleanup therefore preserves both locks
byte-for-byte and records their expected hashes in `scripts/workspace.config.json`.
No fake peer identities, dependency upgrades or package-manager hooks are added.

`node scripts/workspace.mjs verify` checks component names, required files and
lock identity. A deliberate future dependency update should review the graph
change and update that component's recorded checksum.

## Root commands

| Command | Scope |
| --- | --- |
| `pnpm install:all` | Frozen installs for browser and Hub |
| `pnpm typecheck:all` | Both component typechecks |
| `pnpm test:all` | Both default test suites; DB cases keep their explicit gates |
| `pnpm build:all` | Both component builds |
| `pnpm check:all` | Both typechecks, default tests and builds |
| `pnpm workspace:check` | Read-only component/lock validation |
| `pnpm hub:dev`, `hub:build`, `hub:typecheck`, `hub:test`, `hub:check` | Hub only |
| `pnpm test:browser` | Browser native-Chrome local fixture suite |
| `pnpm test:hub-tools` | Hub bootstrap tool tests; dedicated test PostgreSQL required |

The runner roots child working directories explicitly, preserves child exit
status, stops on failure, and does not implicitly start services, migrate data or
deploy. `pnpm build`, `test`, `typecheck`, `start`, `dev`, and `node:start` keep
their existing browser-only meaning for existing operators and image builds.

## Tool organization

- `scripts/`: active build adapters, workspace runner, release/upload/configuration
  helpers, contract sync and the maintained local laboratory entrypoint.
- `tools/diagnostics/`: opt-in browser/site/storage/performance inspection.
- `tools/experiments/`: isolated feasibility work, not production runtime code.
- `tools/lab/`: explicitly paused/local laboratory helpers.
- `tools/legacy/`: dated operators and old reproductions, not current migration or
  deployment procedures.

The exact old-to-new mapping is `tools/TOOLING-MAP.json`. A tool move changes its
source path, not application behavior. Never run every `.mjs` file to “verify” the
repository: some are explicit operators or real-network diagnostics.

## Fixtures, reports and history

Maintained tests use tracked fixtures or construct disposable data. Reports go to
`test-results/` or another ignored output directory. `evidence/` is optional audit
output, not a prerequisite for builds or default tests.

`maintenance/history/` contains the three original startup-history inputs and the
narrow old-entrypoint rollback rehearsal. Historical reports remain historical;
none is a current production rollback manifest.

The missing historical Hub pre-catalog binary/source is not recreated by renaming
current code. Its migration regression uses an explicitly authored pre-0026 SQL
writer contract, with its coverage boundary documented beside the fixture.

## Packaging and data

Main/node uploads preserve server-owned deployment files and exclude Hub/private
local material as before. Hub Docker/Compose contexts remain component-local.
The public source packager uses allowlisted source roots, rejects symlinks, omits
private/generated files and publishes completed archives atomically.

Local originals, recovery material and dirty legacy worktrees are retained under
ignored `local-retained/`; they are not part of a Git push. Do not delete that
folder or application data as part of source cleanup. See [local file retention](LOCAL-FILES.md).
