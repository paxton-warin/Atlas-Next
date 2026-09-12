#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
PIN=e9ff92d1ec98ba140cb4bca840fb40c2b9b52ebf
if [ ! -d upstream/scramjet/.git ]; then
  git clone --filter=blob:none --no-checkout https://github.com/MercuryWorkshop/scramjet.git upstream/scramjet
fi
[ "$(git -C upstream/scramjet rev-parse HEAD 2>/dev/null || true)" = "$PIN" ] || git -C upstream/scramjet checkout "$PIN"
[ -z "$(git -C upstream/scramjet status --porcelain --untracked-files=no)" ] || { echo 'Upstream tracked files changed. Preserve/review them before rebuilding.'; exit 1; }
cd upstream/scramjet
pnpm install --frozen-lockfile --ignore-scripts
(cd packages/core/rewriter/wasm && bash build.sh)
CI=1 pnpm exec rspack build --mode production
VITE_WISP_URL=ws://127.0.0.1:4182/wisp/ pnpm --filter @mercuryworkshop/scramjet-demo build
printf '%s\n' 'UPSTREAM_BUILD_OK'
