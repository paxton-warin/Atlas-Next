# Update existing three-VPS installations

**Only updating focus mode, fullscreen Escape, popout, or YouTube filtering?** Use [the routine browsing-controls update](UPDATE-BROWSING-CONTROLS.md). The migration below changes relay environment/routing and is not needed for those controls.

This update lets **Main server use the visitor's current frontend CloudFront URL for website traffic**. Nodes 2 and 3 keep their own static CloudFront endpoints. Main's frame/static runtime is hosted on a pinned remote node, separate from Atlas's frontend/admin origin; its website transport uses VPS 1 directly. No fourth distribution is needed. AI chat also gains locally rendered LaTeX.

**VPS 2 also hosts the dispenser?** Use [the shared-Caddy recovery guide](VPS2-DISPENSER-RECOVERY.md). Keep its combined Caddy configuration and update only the `node` service; do not recreate its edge with a stock configuration.

These commands update an existing `/opt/atlas` installation, including one originally uploaded by rsync with no `.git` directory. They preserve live origin keys, owner/AI configuration and paired-node volumes. Use your actual SSH user and VPS hostnames. Run nodes first, Main last.

## 1. Upload the same prepared checkout to all three VPSs

On your Mac:

```sh
cd /Users/paxton/Repositories/Atlas-Next
git pull --ff-only origin main
pnpm install --frozen-lockfile
pnpm runtime:fetch
pnpm build
SSH_USER=root bash scripts/upload-update.sh
```

Replace `root` with `deploy` or your existing SSH user if needed. The script defaults to `vps-1.internals.paxton.co`, `vps-2.internals.paxton.co`, and `vps-3.internals.paxton.co`. For a different main hostname:

```sh
SSH_USER=deploy MAIN_HOST=vps-main.internals.paxton.co bash scripts/upload-update.sh
```

The upload does not restart anything. **Before copying source, it saves existing Caddy/Compose files and `caddy`/`caddy.d` directories under a private `backups/deployment-*/deployment.tar`. It leaves those live files unchanged and stages the six standard deployment files under `deployment-templates/` for review.** A failed backup stops that host’s upload before rsync. Staged templates, rather than live custom routing, are used in public source archives. It excludes `.env`, `.env.*` backups, `.origin-key`, databases and live data directories, and explicitly uploads only the two non-secret example env files. Both nodes use this same source checkout, not a separate branch. Git alone does not transfer the prepared runtime/vendor assets; the build/upload steps above do.

### Review deployment changes separately

Source upload no longer activates new deployment configuration. Compare staged files with your live files before applying a change:

```sh
cd /opt/atlas
diff -u Caddyfile.cloudfront deployment-templates/Caddyfile.cloudfront || true
diff -u compose.cloudfront.yaml deployment-templates/compose.cloudfront.yaml || true
```

On Main, merge the frontend `/relay/*`/`/wisp/*` routing into your actual Caddy configuration, keeping the origin-key check first. The staged standard file shows the complete route structure. Preserve custom site blocks, ports, external Docker networks and any Compose override files. Only an installation with **no custom deployment changes**, after backup and review, should copy the staged standard file wholesale. **Do not copy stock `Caddyfile.node` over the combined VPS 2 dispenser config.**

## 2. Update node 2, then node 3

In the owner panel, set the node being updated to **Draining**. For a disruption-free update, wait for both its pinned sessions and hosted frames to reach zero. Otherwise its current sessions will experience the restart; they are not silently moved to another IP. Keep the other node Active.

SSH into that VPS and run:

```sh
cd /opt/atlas
# Preserve the deployment's full Compose file stack. Add any other existing overrides.
NODE_COMPOSE=(sudo docker compose -p atlas-node -f compose.node.yaml)
if test -f compose.dispenser.yaml; then NODE_COMPOSE+=(-f compose.dispenser.yaml); fi
"${NODE_COMPOSE[@]}" config --quiet
# Retain the exact running image before replacing its build tag.
CID=$("${NODE_COMPOSE[@]}" ps -q node)
OLD_IMAGE=$(sudo docker inspect -f '{{.Image}}' "$CID")
sudo docker tag "$OLD_IMAGE" atlas-node:before-frontend-relay
"${NODE_COMPOSE[@]}" build node
"${NODE_COMPOSE[@]}" up -d --no-deps --force-recreate node
"${NODE_COMPOSE[@]}" ps
"${NODE_COMPOSE[@]}" logs --tail=50 node
```

The command intentionally leaves Caddy and the dispenser running. It does not apply staged routing changes or recreate `edge`.

Wait for the node to show **Online**, then set it **Active** again. Repeat for the other VPS. Existing pairing is retained; do not delete `node-data`, named volumes, or reattach the nodes. The updated service advertises the `frontend-relay-v1` capability during authenticated heartbeat checks.

## 3. Update Main on VPS 1

Set Main to **Draining** first if it currently serves sessions. SSH to VPS 1:

```sh
cd /opt/atlas
# Keep previous deployment files and image for rollback.
BACKUP="backups/before-frontend-relay-$(date -u +%Y%m%dT%H%M%SZ)"
sudo install -d -m 700 "$BACKUP"
sudo cp -p .env "$BACKUP/env"
CID=$(sudo docker compose -p atlas-main -f compose.cloudfront.yaml ps -q app)
OLD_IMAGE=$(sudo docker inspect -f '{{.Image}}' "$CID")
sudo docker tag "$OLD_IMAGE" atlas-main:before-frontend-relay

# Change only relay settings; retain origin/admin/AI values. Uses Docker's Node,
# so Node/pnpm need not be installed directly on the VPS.
sudo docker run --rm --user "$(id -u):$(id -g)" \
  -v "$PWD:/work" -w /work node:24-bookworm-slim \
  node scripts/configure-frontend-relay.mjs

sudo docker compose -p atlas-main -f compose.cloudfront.yaml config --quiet
sudo docker compose -p atlas-main -f compose.cloudfront.yaml build app

# Take a consistent snapshot of the complete existing main data volume.
sudo docker compose -p atlas-main -f compose.cloudfront.yaml stop app
sudo docker run --rm --volumes-from "$CID":ro \
  -v "$PWD/$BACKUP:/backup" alpine \
  sh -c 'umask 077; tar -czf /backup/main-data.tgz -C /data .'

# MAIN ONLY: after reviewing/merging its staged routing changes above.
# Recreate both Main services so its changed environment and routes take effect.
sudo docker compose -p atlas-main -f compose.cloudfront.yaml up -d --force-recreate app edge
sudo docker compose -p atlas-main -f compose.cloudfront.yaml ps
sudo docker compose -p atlas-main -f compose.cloudfront.yaml logs --tail=70 app edge
```

Stop and fix any failing command before proceeding. On an existing installation using a different project name, use that original name throughout; otherwise Compose creates a different database volume. Do not run `down -v`.

The env helper sets:

```dotenv
LOCAL_BROWSING=true
LOCAL_RELAY_MODE=frontend
```

It **removes `RUNTIME_HOST` and `RUNTIME_ORIGIN`**, preserves everything else, and writes a private `.env.before-frontend-relay-*` backup. `APP_ORIGIN` stays your stable frontend fallback, e.g. `https://d1twdbqzi40q8d.cloudfront.net`; aliases do not need listing. `ORIGIN_HOST` remains the actual VPS origin hostname. Environment values must be plain values, not Markdown links.

If your previous deployment used `compose.yaml`, inspect the running app's Compose labels first and confirm the existing project/volume before switching:

```sh
sudo docker ps --format '{{.Names}}'
sudo docker inspect YOUR_APP_CONTAINER --format '{{json .Config.Labels}}'
sudo docker inspect YOUR_APP_CONTAINER --format '{{json .Mounts}}'
```

The CloudFront file publishes the same edge ports and preserves the `atlas-data` volume suffix. Use `-f compose.cloudfront.yaml` explicitly in every subsequent command.

## 4. Enable Main and reconnect

1. Open the owner panel through your stable frontend URL.
2. Under **Browsing nodes**, ensure both remote nodes are Online and Active.
3. Set **Main server → Active**, **Weight → 1**. Keep node 2/3 weight 1 unless capacities differ. `LOCAL_BROWSING=true` only seeds new databases; it does not overwrite a previously saved Disabled state.
4. Main should say **Current frontend URL · Main server relay**, not `runtime.invalid`.
5. In the visitor UI, choose **Connection → Reconnect node**. Existing sticky sessions otherwise keep node 2/3. New equal-load assignments include all three; perfect rotation is not expected when their loads differ.

## 5. Check routing

- `/health` on any frontend alias still returns `{"status":"ok","database":"ready"}`. That is correct: its root serves Atlas, not an iframe runtime.
- When assigned Main, DevTools shows the isolated browsing iframe on node 2 or 3, but the transport WebSocket uses `wss://CURRENT_FRONTEND/relay/...`. Website bytes use Main's IP and bandwidth.
- When assigned node 2/3, its transport WebSocket goes directly to that node's CloudFront endpoint, not via VPS 1.
- Reload, reopen a restored browsing tab, and verify the assignment and website cookies remain. Explicit Reconnect can change the frame origin and require website login again.
- AI chat renders `$x^2$`, `$$...$$`, `\(...\)` and `\[...\]` as math. Formula fonts are bundled with Atlas.

Keep the existing CloudFront viewer-request function attached, **CachingDisabled**, **AllViewerExceptHostHeader**, WebSocket headers forwarded, and no response-headers policy injecting `frame-ancestors 'none'` onto node responses. No distribution-origin change is needed for frontend-relay mode. Preserve Atlas's own anti-framing header on the frontend/owner panel.

If a frontend is stale after the new containers are running, reload it and inspect the loaded asset hashes before considering a CloudFront invalidation. If Main says Setup required, check that both nodes were upgraded, are Online/Active, and their heartbeats reach the stable control URL.

## Rollback

Keep the previous source/configuration as well as the tagged images. The uploader now retains pre-upload Caddy/Compose snapshots in `backups/deployment-*/deployment.tar`. These snapshots preserve the state found at upload time; they do not reconstruct a configuration that an earlier upload already overwrote. The env helper backs up the environment independently.

For the main database, this update adds a lease column. **An older image must be restored with the pre-update database snapshot**, not pointed at the migrated database. Stop the app, restore the entire backed-up data volume (including the master key), restore the previous deployment files/env and image, then restart using the same project name. Restore node images and their original data only while those nodes are stopped. The automated rollback rehearsal in local evidence uses disposable source/database fixtures; it does not restore production volumes.

## Local verification

```sh
pnpm check
# Optional: installed Caddy 2 binary, or set CADDY_BIN to its path.
node scripts/cloudfront-routing-probe.mjs
```

The tests exercise real local Scramjet HTTP/WebSocket transport, cookies, sticky assignment, wrong-purpose ticket rejection, Caddy routing, frontend anti-framing headers, and LaTeX. They do not establish live Google/Spotify authentication, production bandwidth or physical Chromebook compatibility.
