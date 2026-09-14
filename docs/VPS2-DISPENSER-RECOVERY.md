# Restore VPS 2's shared Atlas + dispenser Caddy

The combined host file is `/opt/atlas/Caddyfile.node`. Docker mounts that file as `/etc/caddy/Caddyfile` inside `atlas-node-edge-1`—these are two paths to the same configuration, not two separate Caddy installations.

The supplied deployment output identifies:

- Edge: `atlas-node-edge-1`, published ports 80/443.
- Browsing node: `atlas-node-node-1`, container port 4183.
- Dispenser: `atlas-link-dispenser-app-1`, container port 3000, host binding `127.0.0.1:3000`.
- Dispenser origin hostname: `atlas-dispenser-vps-b.internals.paxton.co`.

The earlier upload script copied the repository's stock `Caddyfile.node` and `compose.node.yaml` over destination files; recreating `edge` then loaded the stock node-only route. A local rsync reproduction confirms that overwrite mechanism. This is not evidence that the recovery has already run on the VPS.

## Restore the missing dispenser route

Transfer only the recovery script from your Mac; this avoids running the old bulk updater:

```sh
cd /Users/paxton/Repositories/Atlas-Next
scp scripts/restore-vps2-caddy.sh root@vps-2.internals.paxton.co:/tmp/atlas-restore-vps2-caddy.sh
```

On VPS 2:

```sh
sudo bash /tmp/atlas-restore-vps2-caddy.sh
curl -fsS https://atlas-dispenser-vps-b.internals.paxton.co/health/ready
```

The script requires Bash and Docker on the VPS. It uses the existing edge and dispenser containers; it does not build or restart application/database containers. It reads their actual networks instead of treating the host's port 3000 as reachable via container loopback.

It retains all current Caddy site blocks and adds the missing one:

```caddy
atlas-dispenser-vps-b.internals.paxton.co {
  reverse_proxy atlas-link-dispenser-app-1:3000
}
```

It first backs up the active file to a private directory, validates a candidate inside Caddy with its current environment, connects the edge to a suitable existing dispenser network if necessary, and reloads Caddy. It preserves the bind-mounted file's inode rather than renaming a new file over it. A failed validation/reload/upstream check restores the prior file and removes a network attachment made by that attempt. If that hostname is already present, it stops for review instead of duplicating or replacing an existing site block.

The helper also writes `compose.dispenser.yaml` **only if absent**, recording the external shared Docker network. It does not activate/recreate Compose or overwrite an existing override. When deliberately recreating the edge later, retain your other overrides and include this file:

```sh
cd /opt/atlas
sudo docker compose -p atlas-node -f compose.node.yaml -f compose.dispenser.yaml config --quiet
# Only when an edge recreation is actually intended:
sudo docker compose -p atlas-node -f compose.node.yaml -f compose.dispenser.yaml up -d --no-deps edge
```

Without the override, a manual network connection survives a restart of the same container but not its recreation. Keep the dispenser's external network name stable too. If an existing override differs from the generated network choice, inspect it before a future recreation.

The helper's upstream health check establishes container-to-container access. The final `curl` above checks the public origin's TLS/routing; also check the dispenser's actual frontend/CloudFront URL. Do not expose its database ports or change the host binding to `0.0.0.0` to solve container networking.

## Prevent the next overwrite

The corrected `scripts/upload-update.sh`:

1. Creates `backups/deployment-*/deployment.tar` before source transfer; a failed backup stops that host's upload.
2. Preserves root `Caddyfile*`, `compose*.yaml/yml`, `docker-compose*.yaml/yml` and `caddy`/`caddy.d` directories.
3. Stages the six standard Caddy/Compose files under `deployment-templates/` rather than activating them.
4. Uses those pristine templates in public source archives, excluding live customized deployment contents.

Use the local corrected uploader, not a previously downloaded version. A new backup preserves what is present now; it does not recover an earlier overwritten file.

For routine node application updates, leave the edge alone:

```sh
cd /opt/atlas
sudo docker compose -p atlas-node -f compose.node.yaml -f compose.dispenser.yaml build node
sudo docker compose -p atlas-node -f compose.node.yaml -f compose.dispenser.yaml up -d --no-deps --force-recreate node
```

Include every additional Compose override your deployment already uses. Do not replace a custom Compose file with the staged standard template merely to update the application image.

References: [Caddy validation/reload](https://caddyserver.com/docs/command-line), [Docker user-defined bridge DNS and connectivity](https://docs.docker.com/engine/network/drivers/bridge/), [Compose file selection](https://docs.docker.com/reference/cli/docker/compose/).
