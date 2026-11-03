# Local files and cleanup

Updated November 3, 2026. Browser and Hub source are one Git repository. The
[repository guide](REPOSITORY.md) describes its components and shared commands.

## Keep

- Source, manifests, **both lockfiles**, configuration examples, tests, docs,
  licenses and `maintenance/` history.
- `.git/`, application `data/`, private `.env`/origin keys, database files and
  private backups. Git ignores live data and credentials; a push does not back
  them up.
- `local-retained/`: original dispenser Git metadata, dirty legacy Atlas/node
  worktrees, design material, prior local Hub reports and cleanup recovery copies.
  Its nodes archive remains a registered worktree; do not remove it with Finder
  or prune its metadata blindly. This directory is private and Git-ignored.
- The pinned runtime inputs in `upstream/` while working offline. They can be
  reconstructed by `pnpm runtime:fetch` from the tracked pin/delta bundle, but
  simply removing them requires fetching/preparing again before a build.

## Regenerable output

When local development/tests are stopped, these are disposable:

| Path | Recreate with |
| --- | --- |
| Root and Hub/package `node_modules/` | `pnpm install:all` |
| Root `dist/`; Hub/package `dist/` | `pnpm build:all` |
| `test-results/`, `playwright-report/`, `coverage/`, `.cache/` | Relevant tests/tools |
| `__pycache__/`, `*.pyc`, `*.tsbuildinfo` | Relevant tools/typechecks |
| `runtime/public/` generated pinned bundles, `web/public/source/` | Browser build/preparation |
| `evidence/` | Optional audit tools, when explicitly run |

**The whole `evidence/` folder may now be removed without breaking maintained
builds or default tests.** Required old startup inputs were recovered from Git
into tracked `maintenance/history/`; no maintained migration test imports a
historical evidence source copy. Retain an audit report first if you personally
want its measurements or history. Generated material is not the same as user
application data.

Design archives and old Hub `.codex`/audit/odd placeholder material were moved
intact under `local-retained/`, rather than mixed into current source or deleted.
No application database, master key, authentication credential or browser save
was moved or reset by the repository cleanup.

## Outside this folder

Keep system-managed `~/.aws`, `~/.ssh`, the SSH/password-manager agent, browser
profiles, Docker volumes and installed toolchains. No required sibling project
source remains. Personal Downloads/documents were not classified as expendable.

The current project directory contains the source for both components. Private
retention/data still need their own private backup; Git tracks source, not the
whole laptop or every ignored file.
