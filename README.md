# Atlas

One Git repository for the **browser/Main and browsing nodes** and the **Hub/link
dispenser**. The components keep their existing runtime interfaces, configuration,
database schemas, container contexts and deployment lifecycle.

## Repository layout

| Path | Responsibility |
| --- | --- |
| `web/`, `runtime/`, `server/` | Browser UI, isolated website runtime, Main API and node server |
| `dispenser/apps/` | Hub API and Hub web UI |
| `dispenser/packages/` | Hub shared contracts, PostgreSQL data layer and migrations |
| `scripts/` | Maintained build, development, workspace and release entrypoints |
| `tools/` | Optional diagnostics, experiments, local laboratories and historical operators |
| `tests/` | Browser/Main automated tests; Hub tests remain beside their source |
| `maintenance/history/` | Tracked historical source fixtures, independent of audit output |
| `docs/` | Current documentation index and explicitly historical reports |

Start with [repository/development rules](docs/REPOSITORY.md), the
[documentation index](docs/README.md), or [local file cleanup](docs/LOCAL-FILES.md).

## Install and verify both components

Use Node **24.12+** and the pinned **pnpm 11.15.0**.

```sh
git clone https://github.com/paxton-warin/Atlas-Next.git
cd Atlas-Next
pnpm install:all
pnpm runtime:fetch                 # Fetch/verify the pinned runtime on a fresh clone
pnpm workspace:check              # Component paths and dependency-lock identity
pnpm typecheck:all
pnpm test:all
pnpm build:all
```

`pnpm check:all` runs both components' typechecks, default tests and builds. It
does **not** deploy, start services or run database migrations. Hub database tests
remain gated on an explicitly supplied dedicated test database; skipped database
cases are not counted as passing coverage.

There is one repository and one root command interface, with **two intentionally
isolated dependency graphs**. Both existing lockfiles remain unchanged. Combining
the locks would change nine shared transitive resolutions, so that is deliberately
not part of a behavior-preserving repository cleanup.

## Run a component

Existing browser commands keep their meaning:

```sh
pnpm build
pnpm start                        # Main: http://localhost:4180
pnpm node:start                   # Node process, with its existing configuration
pnpm admin:token
```

The browser runtime's default local origin is `http://127.0.0.1:4181`. Keep the
application/runtime hostname distinction required by its isolation model. Copy
`.env.example` to `.env` for local configuration; keep local data and secrets out
of Git. `pnpm dev` builds and starts Main; it is not a hot-reload server.

Hub commands are available from this same root:

```sh
pnpm hub:dev
pnpm hub:build
pnpm hub:typecheck
pnpm hub:test
```

Hub configuration remains in `dispenser/.env`; it requires PostgreSQL and Redis
for its normal server operation. See [Hub setup](dispenser/README.md). Existing
Hub-local `pnpm`/Compose commands still work from `dispenser/`.

## Additional verification

See [test coverage and known database-suite failures](docs/TESTING.md) for what
the default checks do and do not establish.

```sh
pnpm test:browser                  # Disposable local fixtures and installed Chrome
node scripts/sync-hub-contracts.mjs --check
pnpm test:backup-restore           # More extensive local browser/storage fixtures
```

Playwright's normal output is under `test-results/`, not a source directory. Set
`CHROME_PATH` when Chrome is not in the harness's default location. DB-specific
Hub tests and `pnpm test:hub-tools` require a dedicated `_test` database; never
point them at a live database. A desktop test pass is not physical Chromebook,
real-account site compatibility, production capacity or deployment qualification.

## Deployments remain component-specific

- Browser/Main: root `Dockerfile`, `compose.yaml` / `compose.cloudfront.yaml`.
- Browsing node: root `Dockerfile.node`, `compose.node.yaml`.
- Hub and its workers: `dispenser/` Docker/Compose files.

The repository cleanup does not activate images, recreate services, rotate URLs,
change authentication or replace database volumes. Existing server-owned Caddy,
Compose, environment files and origin keys must remain server-owned. Procedures
and their historical context are indexed in [deployment documentation](docs/README.md).

## Runtime source and licensing

`LICENSE` and `THIRD_PARTY.md` describe the source/licensing material. The runtime
pin and asset/source hashes live in `scripts/runtime-fork.json`; preparation
rejects mismatched bytes. The tracked delta bundle allows the fork to be restored
without depending on an uncommitted sibling checkout.

Builds retain `/source/atlas-source.tar.gz` and
`/source/scramjet-source.tar.gz`. Source packaging includes maintained tooling,
permanent history and available Hub source, while excluding environment secrets,
private retention, dependencies, generated output and audit reports. Component-only
browser build contexts remain supported and do not silently incorporate Hub services.
