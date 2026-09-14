#!/usr/bin/env bash
# Upload application source without replacing server-owned routing/deployment files.
set -euo pipefail
: "${SSH_USER:?Set SSH_USER to your VPS SSH user (for example root or deploy).}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${MAIN_HOST:=vps-1.internals.paxton.co}"
: "${NODE2_HOST:=vps-2.internals.paxton.co}"
: "${NODE3_HOST:=vps-3.internals.paxton.co}"
test -f "$ROOT/web/src/main.tsx"
test -d "$ROOT/upstream/scramjet-ls-bypass/app/vendor"
for host in "$MAIN_HOST" "$NODE2_HOST" "$NODE3_HOST"; do
  # Backup must succeed before transferring anything. Never print file contents.
  ssh "$SSH_USER@$host" 'set -eu
    cd /opt/atlas
    umask 077
    mkdir -p backups
    backup=$(mktemp -d "backups/deployment-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")
    set --
    for file in Caddyfile* compose*.yaml compose*.yml docker-compose*.yaml docker-compose*.yml caddy caddy.d; do
      if [ -e "$file" ] || [ -L "$file" ]; then set -- "$@" "$file"; fi
    done
    if [ "$#" -gt 0 ]; then tar -cf "$backup/deployment.tar" "$@"; fi
    mkdir -p deployment-templates
    printf "Deployment backup: /opt/atlas/%s\n" "$backup"
  '
  rsync -az --exclude='/Caddyfile*' --exclude='/compose*.yaml' --exclude='/compose*.yml' --exclude='/docker-compose*.yaml' --exclude='/docker-compose*.yml' --exclude='/caddy/' --exclude='/caddy.d/' --exclude='/deployment-templates/' --exclude=.git --exclude=node_modules --exclude=.env --exclude=.origin-key --exclude='.env.*' --exclude=data --exclude=node-data --exclude=evidence --exclude=test-results --exclude=playwright-report --exclude=upstream/scramjet --exclude=upstream/demo-original --exclude=target --exclude=backups --exclude='*.sqlite*' --exclude='*.db*' --exclude='*.pem' --exclude='*.key' --exclude=.aws --exclude=.ssh --exclude=.npmrc --exclude='*.log' \
    "$ROOT/" "$SSH_USER@$host:/opt/atlas/"
  # Canonical templates are staged for review/build source archives, never activated.
  rsync -az "$ROOT/Caddyfile" "$ROOT/Caddyfile.cloudfront" "$ROOT/Caddyfile.node" \
    "$ROOT/compose.yaml" "$ROOT/compose.cloudfront.yaml" "$ROOT/compose.node.yaml" \
    "$SSH_USER@$host:/opt/atlas/deployment-templates/"
  ssh "$SSH_USER@$host" 'mkdir -p /opt/atlas/evidence/ui-refinement/original/server'
  scp "$ROOT/.env.example" "$ROOT/.env.node.example" "$SSH_USER@$host:/opt/atlas/"
  scp "$ROOT/evidence/ORIGINAL-sw.js" "$ROOT/evidence/DIFF.patch" "$SSH_USER@$host:/opt/atlas/evidence/"
  scp "$ROOT/evidence/ui-refinement/original/server/index.mjs" "$SSH_USER@$host:/opt/atlas/evidence/ui-refinement/original/server/"
done
printf '%s\n' 'Upload complete. Live Caddy/Compose files preserved. Review deployment-templates before routing changes; update application services only. For routine updates see docs/UPDATE-BROWSING-CONTROLS.md; use docs/UPDATE-FRONTEND-RELAY.md only for the initial relay migration.'
