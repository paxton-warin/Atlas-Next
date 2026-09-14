#!/usr/bin/env bash
# Rebuild one existing Atlas application service using its recorded Compose stack.
# Run from the uploaded checkout, for example:
#   sudo bash scripts/update-running-service.sh atlas-node node
#   sudo bash scripts/update-running-service.sh atlas-main app
set -euo pipefail

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ $# -eq 2 ]] || fail "Usage: $0 atlas-node node | atlas-main app"
project=$1
service=$2
case "$project/$service" in
  atlas-node/node|atlas-main/app) ;;
  *) fail "Expected atlas-node node or atlas-main app." ;;
esac
command -v docker >/dev/null || fail "Docker is not installed or is not on PATH."

source_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
[[ "$(pwd -P)" == "$source_root" ]] || fail "Run this command from the uploaded Atlas checkout."

matches=$(docker ps --filter status=running \
  --filter "label=com.docker.compose.project=$project" \
  --filter "label=com.docker.compose.service=$service" --format '{{.ID}}')
containers=()
while IFS= read -r candidate; do
  [[ -z "$candidate" ]] || containers+=("$candidate")
done <<< "$matches"
[[ ${#containers[@]} -eq 1 ]] || fail "Expected exactly one running $project/$service container; found ${#containers[@]}."
cid=${containers[0]}

label() { docker inspect --format "{{ index .Config.Labels \"$1\" }}" "$cid"; }
present() { [[ -n "$1" && "$1" != '<no value>' && "$1" != '<nil>' ]]; }
[[ "$(label com.docker.compose.project)" == "$project" ]] || fail "Selected container's project does not match."
[[ "$(label com.docker.compose.service)" == "$service" ]] || fail "Selected container's service does not match."
[[ "$(docker inspect --format '{{.State.Running}}' "$cid")" == true ]] || fail "Selected container is no longer running."
working_dir=$(label com.docker.compose.project.working_dir)
present "$working_dir" || fail "The running container has no recorded Compose working directory."
[[ -d "$working_dir" ]] || fail "The recorded Compose working directory is missing."
working_dir="$(cd "$working_dir" && pwd -P)"
[[ "$working_dir" == "$source_root" ]] || fail "The uploaded checkout does not match the running deployment's working directory."

config_files=$(label com.docker.compose.project.config_files)
present "$config_files" || fail "The running container has no recorded Compose file stack."
compose=(docker compose --project-directory "$working_dir" -p "$project")
add_files() {
  local value=$1 option=$2 file
  local files=()
  [[ "$value" != ,* && "$value" != *, && "$value" != *,,* && "$value" != *$'\n'* && "$value" != *$'\r'* ]] || fail "The recorded Compose file list is malformed."
  IFS=',' read -r -a files <<< "$value"
  [[ ${#files[@]} -gt 0 ]] || fail "The recorded Compose file list is empty."
  for file in "${files[@]}"; do
    case "$file" in /*) ;; *) file="$working_dir/$file" ;; esac
    [[ -f "$file" && -r "$file" ]] || fail "A recorded Compose or environment file is missing or unreadable."
    compose+=("$option" "$file")
  done
}
add_files "$config_files" -f
environment_files=$(label com.docker.compose.project.environment_file)
if present "$environment_files"; then add_files "$environment_files" --env-file; fi

# Quiet validation avoids printing resolved environment variables or credentials.
"${compose[@]}" config --quiet
old_image=$(docker inspect --format '{{.Image}}' "$cid")
present "$old_image" || fail "The running container's image is missing."
rollback_image="$project-$service:before-update-$(date -u +%Y%m%dT%H%M%SZ)-$$"
docker tag "$old_image" "$rollback_image"
printf 'ROLLBACK_IMAGE=%s\n' "$rollback_image"

"${compose[@]}" build "$service"
"${compose[@]}" up -d --no-deps --force-recreate --no-build --pull never --wait --wait-timeout 120 "$service"
"${compose[@]}" ps "$service"
"${compose[@]}" logs --tail=50 "$service"
printf 'UPDATE_RECREATED=%s/%s; ROLLBACK_IMAGE=%s\n' "$project" "$service" "$rollback_image"
