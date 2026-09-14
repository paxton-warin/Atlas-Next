#!/usr/bin/env bash
# Restore the confirmed VPS 2 dispenser site without replacing Atlas routes.
# Usage: sudo bash scripts/restore-vps2-caddy.sh [/opt/atlas/Caddyfile.node]
set -euo pipefail
umask 077

config=${1:-/opt/atlas/Caddyfile.node}
edge=atlas-node-edge-1
dispenser=atlas-link-dispenser-app-1
site=atlas-dispenser-vps-b.internals.paxton.co

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ $# -le 1 ]] || fail "Usage: $0 [Caddyfile.node path]"
[[ -f "$config" && ! -L "$config" ]] || fail "Expected a regular, non-symlink Caddyfile: $config"
config="$(cd "$(dirname "$config")" && pwd -P)/$(basename "$config")"
base=$(dirname "$config")

# Be deliberately conservative: do not duplicate or rewrite any existing site,
# even if it is embedded in a multi-host site block or an imported snippet.
if awk -v host="$site" '!/^[[:space:]]*#/ && index($0, host) { found=1 } END { exit !found }' "$config"; then
  printf 'EXISTING_SITE=REVIEW_REQUIRED; no changes made.\nReview the existing %s route in %s.\n' "$site" "$config"
  exit 0
fi

for container in "$edge" "$dispenser"; do
  running=$(docker inspect --format '{{.State.Running}}' "$container")
  [[ "$running" == true ]] || fail "Container is not running: $container"
done
mounted=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{println .Source}}{{end}}{{end}}' "$edge")
[[ "$mounted" == "$config" ]] || fail "The edge container does not mount $config at /etc/caddy/Caddyfile; inspect the mount before recovery."

app_networks=$(docker inspect --format '{{range $name, $network := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$dispenser")
edge_networks=$(docker inspect --format '{{range $name, $network := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$edge")
eligible=()
shared=()
while IFS= read -r network; do
  [[ -n "$network" ]] || continue
  case "$network" in bridge|host|none) continue ;; esac
  [[ "$network" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || fail "Unexpected Docker network name."
  # Inspect existence rather than treating an arbitrary string as a network.
  docker network inspect "$network" >/dev/null
  eligible+=("$network")
  if printf '%s\n' "$edge_networks" | grep -Fxq "$network"; then
    shared+=("$network")
  fi
done <<< "$app_networks"

join_network=0
if [[ ${#shared[@]} -eq 1 ]]; then
  network=${shared[0]}
elif [[ ${#shared[@]} -gt 1 ]]; then
  fail "Multiple shared dispenser networks found; review Docker networking before recovery."
elif [[ ${#eligible[@]} -eq 1 ]]; then
  network=${eligible[0]}
  join_network=1
else
  fail "Expected one eligible dispenser network; found ${#eligible[@]}. Review Docker networking before recovery."
fi

backup_root="$base/backups"
mkdir -p "$backup_root"
chmod 700 "$backup_root"
backup=$(mktemp -d "$backup_root/vps2-caddy-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")
cp -p "$config" "$backup/Caddyfile.node"
candidate="$backup/Caddyfile.candidate"
cat "$config" > "$candidate"
printf '\n# Dispenser shares this Caddy instance with the Atlas node.\n%s {\n  reverse_proxy %s:3000\n}\n' "$site" "$dispenser" >> "$candidate"

remote_candidate="/etc/caddy/.atlas-dispenser-recovery-$$"
live_changed=0
network_joined=0
override_created=0
override="$base/compose.dispenser.yaml"
cleanup() {
  rc=$?
  trap - EXIT INT TERM
  set +e
  if [[ "$rc" -ne 0 ]]; then
    if [[ "$live_changed" -eq 1 ]]; then
      # Keep the bind-mounted inode: replacing it with mv/cp can leave Caddy
      # looking at the old inode rather than the host file's restored content.
      if cat "$backup/Caddyfile.node" > "$config" &&
        docker exec "$edge" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile > "$backup/rollback.log" 2>&1; then
        printf 'ROLLBACK=CADDY_RESTORED\n' >&2
      else
        printf 'ROLLBACK=REVIEW_REQUIRED; restore from %s and inspect %s\n' "$backup/Caddyfile.node" "$backup/rollback.log" >&2
      fi
    fi
    if [[ "$network_joined" -eq 1 ]]; then
      if docker network disconnect "$network" "$edge" > "$backup/disconnect.log" 2>&1; then
        printf 'ROLLBACK=NEW_NETWORK_DETACHED\n' >&2
      else
        printf 'ROLLBACK=NETWORK_REVIEW_REQUIRED; inspect %s\n' "$backup/disconnect.log" >&2
      fi
    fi
    [[ "$override_created" -ne 1 ]] || rm -f "$override"
  fi
  docker exec "$edge" rm -f "$remote_candidate" >/dev/null 2>&1
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Validate beside the mounted Caddyfile so relative imports still resolve, and
# inside the current container so the existing origin-key environment is used.
docker exec -i "$edge" sh -c 'umask 077; cat > "$1"' sh "$remote_candidate" < "$candidate"
if ! docker exec "$edge" caddy validate --config "$remote_candidate" --adapter caddyfile > "$backup/validate.log" 2>&1; then
  fail "Candidate validation failed; live Caddyfile unchanged. Details: $backup/validate.log"
fi
if [[ "$join_network" -eq 1 ]]; then
  docker network connect "$network" "$edge"
  network_joined=1
fi

live_changed=1
cat "$candidate" > "$config"
# A previous atomic replacement on the host may have left a stale bind mount.
# Do not claim a successful reload unless the container sees these exact bytes.
docker exec "$edge" cat /etc/caddy/Caddyfile > "$backup/mounted-candidate"
if ! cmp -s "$candidate" "$backup/mounted-candidate"; then
  fail "The container sees a stale Caddy bind mount; restoring host bytes. Review the mount before recreation."
fi
if ! docker exec "$edge" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile > "$backup/reload.log" 2>&1; then
  fail "Caddy reload failed; restoring previous bytes. Details: $backup/reload.log"
fi
if ! docker exec "$edge" wget -q -T 15 -O /dev/null "http://$dispenser:3000/health/ready" > "$backup/upstream.log" 2>&1; then
  fail "Dispenser readiness failed from the edge container; restoring previous configuration. Details: $backup/upstream.log"
fi

if [[ -e "$override" || -L "$override" ]]; then
  printf 'OVERRIDE=PRESERVED; review %s for external network %s before future recreation.\n' "$override" "$network"
else
  # This is only staged, never activated here. Compose merges this added edge
  # network with the existing atlas-node network from the base configuration.
  (set -C; cat > "$override" <<EOF
# Keep the dispenser network attached when the Atlas edge is recreated.
services:
  edge:
    networks:
      atlas-dispenser-shared: {}
networks:
  atlas-dispenser-shared:
    external: true
    name: "$network"
EOF
  )
  override_created=1
  printf 'OVERRIDE=STAGED; %s\n' "$override"
fi

printf 'CADDY=RELOADED; DISPENSER_UPSTREAM=READY; NETWORK=%s\nBACKUP=%s\n' "$network" "$backup"
printf '\nNo containers were restarted. Check https://%s/health/ready from your browser.\n' "$site"
printf 'Before a future edge recreation, review both files and explicitly keep the override:\n'
printf 'cd %q\n' "$base"
printf '%s\n' 'docker compose -p atlas-node -f compose.node.yaml -f compose.dispenser.yaml config --quiet'
printf '%s\n' 'docker compose -p atlas-node -f compose.node.yaml -f compose.dispenser.yaml up -d --no-deps edge'
