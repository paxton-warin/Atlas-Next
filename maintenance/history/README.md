# Preserved startup history

These are immutable source-history inputs, **not current deployment instructions**:

- `original-sw.js`: the original worker source.
- `original-server-index.mjs`: the original startup entrypoint used to reproduce
  a fixed September 2026 routing defect.
- `DIFF.patch`: the corresponding historical patch.
- `VERIFICATION-20260910.txt`: the original report, retained unchanged. Paths,
  counts and deployment statements in that report describe its recorded date.
- `rollback-entrypoint.sh`: a hash-guarded **copied-entrypoint rehearsal**. It does
  not roll back an application release, database, Hub, or production service.

The original three files were recovered byte-for-byte from the parent Git
history after the disposable `evidence/` directory was removed. They now have
permanent tracked paths, so builds do not depend on audit output. The source
packager includes this directory. Never restore this deliberately defective old
entrypoint over the running application.
