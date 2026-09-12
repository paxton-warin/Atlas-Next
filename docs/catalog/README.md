# Bundled library

Atlas ships 225 games (including its original six) and 50 apps. The expansion contains 269 distinct HTTPS destinations and 263 local cover files; the remaining cards have an initial-letter fallback. The catalog is served locally, not fetched from GitHub at runtime.

Source: [Interstellar](https://github.com/UseInterstellar/Interstellar/tree/1e13802605b1ff85461adcb0c438594cbe600415), pinned commit `1e13802605b1ff85461adcb0c438594cbe600415`, `static/assets/json/a.json` and `g.json`. The original AGPL license is adjacent to this file. Images and names identify the respective providers/games.

`scripts/import-catalog.py` refreshes the snapshot explicitly. It ignores relative `/e/` routes (those require another deployment's files), deduplicates destinations, copies covers locally, and excludes 404/410, 5xx and unreachable entries. The initial run excluded 69 unreachable/erroring destinations. HTTP 403/challenge responses are retained rather than represented as proven game failures. The request-status/cover-hash report is in `evidence/panic-shortcuts/catalog-checks.json`.

These are launch links, not 275 fully offline applications. HTTP reachability does not prove complete gameplay, streaming, payment, login or DRM compatibility. The browser tests launch a deterministic app fixture through the real runtime; they do not log into external services. Subscription/cloud-game entries may need provider accounts or payment.

The one-time SQLite migration uses `INSERT OR IGNORE`, preserving existing owner titles, URLs, visibility, and other edits. The owner catalog supports search, app/game filters, entry type, edits, and visibility. New catalog migrations should use a new version key; do not remove the stored seed flag to force owner-edited data to refresh.
