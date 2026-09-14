#!/usr/bin/env bash
# Upload the same prepared main checkout to all three servers. Does not restart them.
set -euo pipefail
: "${SSH_USER:?Set SSH_USER to your VPS SSH user (for example root or deploy).}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${MAIN_HOST:=vps-1.internals.paxton.co}"
: "${NODE2_HOST:=vps-2.internals.paxton.co}"
: "${NODE3_HOST:=vps-3.internals.paxton.co}"
test -f "$ROOT/web/src/main.tsx"
test -d "$ROOT/upstream/scramjet-ls-bypass/app/vendor"
for host in "$MAIN_HOST" "$NODE2_HOST" "$NODE3_HOST"; do
  rsync -az --exclude=.git --exclude=node_modules --exclude=.env --exclude=.origin-key --exclude='.env.*' --exclude=data --exclude=node-data --exclude=evidence --exclude=test-results --exclude=playwright-report --exclude=upstream/scramjet --exclude=upstream/demo-original --exclude=target --exclude=backups --exclude='*.sqlite*' --exclude='*.db*' --exclude='*.pem' --exclude='*.key' --exclude=.aws --exclude=.ssh --exclude=.npmrc --exclude='*.log' \
    "$ROOT/" "$SSH_USER@$host:/opt/atlas/"
  ssh "$SSH_USER@$host" 'mkdir -p /opt/atlas/evidence/ui-refinement/original/server'
  scp "$ROOT/.env.example" "$ROOT/.env.node.example" "$SSH_USER@$host:/opt/atlas/"
  scp "$ROOT/evidence/ORIGINAL-sw.js" "$ROOT/evidence/DIFF.patch" "$SSH_USER@$host:/opt/atlas/evidence/"
  scp "$ROOT/evidence/ui-refinement/original/server/index.mjs" "$SSH_USER@$host:/opt/atlas/evidence/ui-refinement/original/server/"
done
printf '%s\n' 'Upload complete. Update node 2, node 3, then main using docs/UPDATE-FRONTEND-RELAY.md.'
