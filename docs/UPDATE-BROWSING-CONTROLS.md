# Update focus mode, fullscreen Escape, popout, and YouTube filtering

This is a **routine application/runtime update**, not the earlier frontend-relay migration. Keep the current CloudFront setup, `.env`, Caddy routes, Docker networks, and paired-node identities. Do not run `configure-frontend-relay.mjs`, the Caddy recovery script, or copy `deployment-templates/` over live files for this update.

The release includes:

- Focus mode hides both top and sidebar tabs while retaining the address bar.
- Fullscreen games request Escape-only keyboard capture where the browser supports it; Escape no longer exits Atlas focus mode.
- **Pop out tab** appears beside the focus control and opens the existing assigned runtime directly.
- **YouTube ad blocker** defaults on in the shared wizard and Settings Browser section; saved opt-outs are respected.
- Source uploads back up and preserve server-owned Caddy/Compose files, including the combined dispenser configuration on VPS 2.

## 1. Prepare and upload from your Mac

Use the Atlas-Next checkout, not Atlas-Link-Dispenser. This also works when `/opt/atlas` was originally uploaded without a `.git` directory.

```sh
cd /Users/paxton/Repositories/Atlas-Next
git pull --ff-only origin main
pnpm install --frozen-lockfile
pnpm runtime:fetch
pnpm build
SSH_USER=root \
  MAIN_HOST=vps-1.internals.paxton.co \
  NODE2_HOST=vps-2.internals.paxton.co \
  NODE3_HOST=vps-3.internals.paxton.co \
  bash scripts/upload-update.sh
```

Use `MAIN_HOST=vps-main.internals.paxton.co` instead if that is the actual DNS name for VPS 1. Use your existing SSH user if it is not root.

The upload transfers prepared runtime assets as well as source. It saves existing deployment files under private `backups/deployment-*/deployment.tar`, leaves them in place, and stages standard templates separately. It does not restart services or upload live `.env`/keys/databases.

## 2. Update VPS 2, then VPS 3

In the owner panel, set the node being updated to **Draining**. Wait for its active sessions and hosted frames to finish if you want to avoid interrupting them; otherwise those sessions will experience the restart. Keep the other node available.

On **VPS 2**:

```sh
cd /opt/atlas
sudo bash scripts/update-running-service.sh atlas-node node
```

After it shows Online in the owner panel, set it **Active** again. Repeat the same command on **VPS 3**, draining only that node first.

The helper reads the running service's project directory and ordered Compose-file stack, including recorded overrides. It validates the stack, retains the previous image under a unique rollback tag, builds `node`, and recreates only `node` with `--no-deps`. Caddy `edge`, the dispenser, PostgreSQL, Redis, and existing volumes are not update targets. Missing/ambiguous running services or missing deployment metadata stop the command before recreation.

## 3. Update Main last

Drain Main first if it currently serves browsing sessions. On **VPS 1**:

```sh
cd /opt/atlas
sudo bash scripts/update-running-service.sh atlas-main app
```

This uses Main's existing Compose stack and recreates only `app`. It does not rewrite `.env` or restart Main's Caddy. Return Main to its previous Active state after checking it is healthy.

These commands use the established `atlas-node/node` and `atlas-main/app` project/service pairs. A deployment using other project names needs its actual running labels reviewed rather than starting a new Compose project with a different data volume.

## 4. Check the update

- Both remote nodes show Online/Active; Main retains its prior assignment configuration.
- VPS 2's dispenser URL still responds. Its Caddy container should not have been recreated by this procedure.
- Refresh the Atlas frontend and reopen existing runtime/popout pages so they load the new bundles.
- Check focus mode in both tab layouts, the popout button beside focus, and **Settings → Browser → YouTube ad blocker**.
- Toggle the blocker and reload existing YouTube tabs. Reopen older popped-out pages from Atlas to inherit a changed preference.
- Check an actual GeForce NOW session and live YouTube playback. The release's automated checks use controlled fixtures, not authenticated live services.

No additional domain, CloudFront behavior, environment variable, API key, or node reattachment is required by these controls. Do not use `docker compose down -v`. Retain the image tag printed by the helper and the pre-upload deployment backup until you have checked the update.

The helper uses the documented [Compose file-stack options](https://docs.docker.com/reference/cli/docker/compose/) and [service-specific `up --no-deps`](https://docs.docker.com/reference/cli/docker/compose/up/). Selecting only the app/node service avoids recreating the shared edge as part of this routine update.
