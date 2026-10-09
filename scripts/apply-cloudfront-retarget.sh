#!/usr/bin/env bash
# Retarget one EXISTING Atlas app/node without recreating it or changing Caddy.
set -euo pipefail
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ $# -eq 2 || $# -eq 3 ]] || fail "Usage: $0 main|node PLAN_JSON [--apply]"
mode=$1
case "$mode" in
  main) project=atlas-main; service=app ;;
  node) project=atlas-node; service=node ;;
  *) fail 'Expected main or node.' ;;
esac
apply=false
if [[ $# -eq 3 ]]; then [[ "$3" == --apply ]] || fail 'Only --apply is accepted as the third argument.'; apply=true; fi
command -v docker >/dev/null || fail 'Docker is not on PATH.'
[[ -f "$2" && -r "$2" && ! -L "$2" ]] || fail 'Plan must be a readable regular JSON file, not a symlink.'
plan="$(cd "$(dirname "$2")" && pwd -P)/$(basename "$2")"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source_root="$(cd "$script_dir/.." && pwd -P)"
helper="$script_dir/retarget-cloudfront.mjs"
[[ -f "$helper" && -r "$helper" ]] || fail 'Sibling retarget-cloudfront.mjs is missing.'
[[ "$plan$helper" != *:* ]] || fail 'Move the checkout and plan to paths without colons for Docker bind mounts.'

matches=$(docker ps --filter status=running \
  --filter "label=com.docker.compose.project=$project" \
  --filter "label=com.docker.compose.service=$service" --format '{{.ID}}')
containers=()
while IFS= read -r candidate; do [[ -z "$candidate" ]] || containers+=("$candidate"); done <<< "$matches"
[[ ${#containers[@]} -eq 1 ]] || fail "Expected exactly one running $project/$service container; found ${#containers[@]}."
cid=${containers[0]}
[[ "$cid" =~ ^[a-f0-9]+$ ]] || fail 'Unexpected container ID.'
label() { docker inspect --format "{{ index .Config.Labels \"$1\" }}" "$cid"; }
[[ "$(label com.docker.compose.project)" == "$project" ]] || fail 'Selected container project changed.'
[[ "$(label com.docker.compose.service)" == "$service" ]] || fail 'Selected container service changed.'
[[ "$(docker inspect --format '{{.State.Running}}' "$cid")" == true ]] || fail 'Selected container is no longer running.'
image=$(docker inspect --format '{{.Image}}' "$cid")
[[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]] || fail 'Unexpected existing image ID.'

# A fresh, network-isolated process uses the existing image and the same data.
# No Compose operation, image pull/build, environment or edge mutation occurs.
if ! docker run --rm --pull=never --network none --user 0:0 \
  --volumes-from "$cid:ro" \
  -v "$helper:/work/retarget.mjs:ro" -v "$plan:/work/plan.json:ro" \
  --entrypoint node "$image" /work/retarget.mjs "$mode" --data /data --plan /work/plan.json; then
  fail 'Dry-run validation failed. The running service was not stopped or changed.'
fi
if [[ "$apply" == false ]]; then
  printf 'DRY_RUN_ONLY=1; SERVICE=%s/%s; rerun with --apply to stop, back up and migrate this service.\n' "$project" "$service"
  exit 0
fi

umask 077
mkdir -p "$source_root/backups"
backup=$(mktemp -d "$source_root/backups/cloudfront-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")
chmod 700 "$backup"
printf 'SELECTED_CONTAINER=%s; SERVICE=%s/%s; BACKUP_ROOT=%s\n' "$cid" "$project" "$service" "$backup"
if ! docker stop --time 30 "$cid"; then fail "Stop failed. Inspect container $cid before retrying; no migration was run."; fi
if [[ "$(docker inspect --format '{{.State.Running}}' "$cid")" != false ]]; then
  fail "Container $cid is still running. No migration was run. Inspect it before retrying."
fi
if ! docker run --rm --pull=never --network none --user 0:0 \
  --volumes-from "$cid" \
  -v "$helper:/work/retarget.mjs:ro" -v "$plan:/work/plan.json:ro" -v "$backup:/backup:rw" \
  --entrypoint node "$image" /work/retarget.mjs "$mode" --data /data --plan /work/plan.json \
  --apply --offline --backup-dir /backup; then
  fail "Migration failed; container $cid remains stopped. Backup root: $backup. Inspect the output and backup before restoring or restarting. No automatic rollback was performed."
fi
if ! docker start "$cid"; then
  fail "Migration completed but restart failed; inspect container $cid. Backup root: $backup."
fi
[[ "$(docker inspect --format '{{.State.Running}}' "$cid")" == true ]] || fail "Container $cid did not remain running. Inspect its logs; backup root: $backup."
printf 'RETARGET_COMPLETE=1; CONTAINER_STARTED=%s; BACKUP_ROOT=%s; check application health and node heartbeats.\n' "$cid" "$backup"
