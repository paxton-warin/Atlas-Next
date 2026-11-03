# Optional investigation and historical tools

Normal build, install, development and release entrypoints are in the root
`package.json` and `scripts/`. These directories separate optional tools from
those maintained application entrypoints:

- **`diagnostics/`** — browser probes, compatibility scans, screenshots, workload
  comparisons and local Hub walkthroughs. Their original checks are retained.
- **`lab/perf-staging/`** — explicitly started, isolated performance laboratory and
  its mocked unit tests. Moving its source does not start, stop or alter a stack.
- **`experiments/`** — storage-bridge feasibility prototypes, not the normal Atlas
  runtime or build pipeline.
- **`legacy/`** — dated production investigations and the previous account-specific
  CloudFront redirect utility. These retain their original account/endpoint logic;
  their presence is not a current deployment or migration recommendation.

`TOOLING-MAP.json` records every old and new entrypoint. Run manual tools from the
**repository root**, e.g. `node tools/diagnostics/analyze-compatibility-har.mjs ...`.
Some historical comparisons require explicitly supplied original build/report
inputs. Those deleted local snapshots are not recreated or treated as current
application source by this cleanup. Report output is generated local data, not a
source dependency.

These tools are not invoked by normal browsing or Hub use. Browser/remote/manual
probes are not automatically run as part of the default unit suite. Local mocked
laboratory checks can be run without starting services:

```sh
node --test tools/lab/perf-staging/*.test.mjs
```

The tracked test suite stays in `tests/`; moving optional entrypoints does not
remove regression coverage. Source imports and script paths are checked by
`tests/tooling-layout.test.mjs`.
