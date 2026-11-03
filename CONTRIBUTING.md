# Working on Atlas

This repository owns both browser/Main/node source and Hub source. Start with
[the repository guide](docs/REPOSITORY.md). Use the root `*:all` commands for changes
that cross components; old browser commands remain browser-only.

- Keep business/runtime behavior changes separate from repository maintenance.
- Preserve component deployment contexts, public asset paths, database migrations,
  environment names and request/authentication contracts unless a task explicitly
  changes them.
- Keep fixtures in `tests/` or beside Hub tests. Never require `evidence/` output
  as an input to a maintained build or automated test.
- Put maintained entrypoints in `scripts/`; optional investigations belong in the
  appropriate `tools/` category. Update references/tests when moving a file.
- Keep historical release claims in `docs/archive/`, not the current README.
- Keep databases, keys, credentials, generated files and local retention out of Git
  and source/image/upload contexts. Use example configuration only.
- Both lockfiles intentionally preserve their existing component resolutions. A
  deliberate dependency update must update its lock checksum in
  `scripts/workspace.config.json` and pass the relevant component checks.

Run `pnpm workspace:check`, `pnpm typecheck:all`, `pnpm test:all` and
`pnpm build:all`. Database-gated and native-browser tests require their documented
local prerequisites; report skipped cases accurately. No check command performs
production deployment.
