# Update focus mode, fullscreen Escape, popout, and YouTube filtering

This is a **routine application/runtime update**, not the earlier frontend-relay migration. Keep the current CloudFront setup, `.env`, Caddy routes, Docker networks, and paired-node identities. Do not run `configure-frontend-relay.mjs`, the Caddy recovery script, or copy `deployment-templates/` over live files for this update.

The release includes:

- Focus mode hides both top and sidebar tabs while retaining the address bar.
- Fullscreen games request Escape-only keyboard capture where the browser supports it; Escape no longer exits Atlas focus mode.
- **Pop out tab** appears beside the focus control and opens a thin `/popout` shell on the current frontend origin, keeping the assigned runtime's storage partition. **Connection → Open direct node tab** remains available separately and may need a separate website login.
- **YouTube ad blocker** defaults on in the shared wizard and Settings Browser section; saved opt-outs are respected.
- Source uploads back up and preserve server-owned Caddy/Compose files, including the combined dispenser configuration on VPS 2.
- The compatibility update also fixes raw authentication-cookie preservation, standalone sign-in popup return and GET navigation headers; fresh expired saved sessions renew before restoring tabs, while live sessions still require explicit reconnection. Runtime asset compression/preloading and bounded DNS reuse reduce avoidable startup work.

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
- Confirm the popout stays on the frontend `/popout` URL, the assigned node is unchanged, and opening/reloading it leaves the original tab and draft intact. Test **Open direct node tab** separately: it intentionally uses the node URL and a different top-level storage context.
- Check real ChatGPT/X sign-in in the affected browser. Local cookie and popup tests are not a live provider-login qualification. Record the node and whether failure happens embedded, in the frontend popout, or in the separate direct-node tab; do not export authentication cookies or tokens.
- Toggle the blocker and reload existing YouTube tabs. Reopen older popped-out pages from Atlas to inherit a changed preference.
- Check an actual GeForce NOW session and live YouTube playback. The release's automated checks use controlled fixtures, not authenticated live services.

No additional domain, CloudFront behavior, environment variable, API key, or node reattachment is required by these controls. Do not use `docker compose down -v`. Retain the image tag printed by the helper and the pre-upload deployment backup until you have checked the update.

### Remaining site-specific checks

On September 29, direct IPv4 HTTPS requests from all three VPSs received ESPN's own CloudFront **403 Request blocked**, including requests made outside Atlas. DNS and certificate validation succeeded. IPv6 requests had no working connection on those VPSs. The integration update does not resolve this upstream rejection; changing Atlas's viewer domains or disabling its origin key is not a demonstrated fix.

The supplied content-filter snapshot reads rendered text and page structure in addition to URLs. The generic Atlas title and encoded paths are not a guarantee against content classification. Verify the actual affected browser/version separately.

The helper uses the documented [Compose file-stack options](https://docs.docker.com/reference/cli/docker/compose/) and [service-specific `up --no-deps`](https://docs.docker.com/reference/cli/docker/compose/up/). Selecting only the app/node service avoids recreating the shared edge as part of this routine update.

## Client compatibility canary — 2026-10-13

This release adds Page compatibility controls, bounded local diagnostics, owned-loader cleanup and the prefix import-map fix. Read `docs/CLIENT-COMPATIBILITY-20261013.md` for measured limits and outstanding real-site checks.

The uploader now includes VPS 4, stages templates without replacing live Caddy/Compose, uses rsync instead of the unavailable SFTP/scp subsystem, and accepts explicit target hosts. It uploads source only; it does not restart services. Default order is Nodes 2, 3, 4, then Main. **Explicit single-host selection** is preferred for a canary.

1. In Atlas administration, set one healthy canary node to **Draining** and wait for active connections to finish. Keep pairing identities, `.env`, origin keys, volumes, and shared Caddy unchanged. Record the current deployed asset manifest.
2. Upload only that node from the Mac, e.g. VPS 4:

   ```sh
   cd /Users/paxton/Repositories/Atlas-Next
   pnpm runtime:fetch && pnpm build
   SSH_USER=root bash scripts/upload-update.sh vps-4.internals.paxton.co
   ```

3. While the node drains, optionally build without restarting it:

   ```sh
   ssh root@vps-4.internals.paxton.co 'cd /opt/atlas && bash scripts/update-running-service.sh atlas-node node --build-only'
   ```

   The helper verifies the original container remains running on its original image. This prepares an image only; it does not activate or qualify it.

   After connections reach zero and remain quiet across two heartbeats, update the application service using the existing Compose-stack-aware helper. It keeps the previous image under a unique rollback tag. Record the original image reference and Compose stack for image rollback. Save that output:

   ```sh
   ssh root@vps-4.internals.paxton.co
   cd /opt/atlas
   sudo bash scripts/update-running-service.sh atlas-node node
   ```

   Do not activate staged templates or recreate `edge`, the dispenser, or data services. If the established project/service differs, use the actual running labels rather than creating a new project.

4. Compare the deployed runtime manifest's source commit/eight hashes with `scripts/runtime-fork.json`; verify `/health`, node heartbeat, game controls/fullscreen/storage, restore, popout, login/logout and streamed replies with the same frontend/node. Keep ESPN/ESPN+ checks separate. A different IP or a login page is not a pass.
5. Restore **Active** only after qualification. Upload/update the remaining Nodes 2/3/4 one at a time, then Main last. On Main use the existing `atlas-main/app` helper command from the earlier steps; never restart shared Caddy or the dispenser as part of this runtime release.
6. If canary acceptance fails, retag the retained previous image to the recorded service image reference, then recreate only `node` using the unchanged recorded Compose stack with `--no-deps --no-build --pull never --wait`. Keep identities/volumes and deployment files unchanged; compare health and manifest with the saved baseline. The separate local working-copy rollback package is at `evidence/client-compatibility-20261013/ROLLBACK.sh`; it rejects mismatched hashes rather than overwriting later edits. Do not use a local-working-copy rollback as a replacement for the server's image rollback.

Package creation does not itself deploy. VPS 4 was subsequently activated after the operator authorized a forced application-service restart during the quiet period, despite live leases. Its identity and deployment files remained unchanged, and the edge was not restarted. The subsequent pin adds named-export rewriting and native SVG fragment fixes for the reported root-module reload loop and missing icons. The operator then confirmed fresh ChatGPT sign-in/visible streaming replies and ESPN sign-in/entitled ESPN+ video/audio on Node 4. The owner/admin client selector was implemented and tested after that runtime qualification, as requested. Fleet/Main deployment results and GitHub push receipts are recorded separately; the release procedure retains Main-last ordering and preserves shared routing/data services.

## Owner-only selection for the current browser

In the control room, open **Browsing nodes → This browser's connection**.
Choose an online node (including a draining canary), then **Apply to this browser**.
**Automatic** selects from active nodes using the usual load-balancing policy.
The selection creates a new pin only for the supplied browser session; it does
not change node state, weight, pairing identity, or other clients' assignments.
Saved Atlas tabs remain available. Site sign-in state is node-local, so switching
nodes may require signing into websites normally again.

The owner endpoint `/api/admin/nodes/select` requires the administrator session,
CSRF token and same-origin checks. The public allocation API ignores node
preferences. A failed selection removes its new reservation and leaves the old
pin in place; a successful replacement is persisted under the startup/session
lock before the frontend applies it. When device persistence is unavailable,
the selected pin remains active for that window and the UI explains that reload
may select another connection. Draining nodes remain excluded from ordinary
new-session allocation.
