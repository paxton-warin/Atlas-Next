#!/usr/bin/env bash
set -euo pipefail
command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }
random_urlsafe(){ openssl rand -base64 "$1" | tr -d '\n=+/' | cut -c1-"$2"; }
printf 'POSTGRES_PASSWORD=%s\n' "$(random_urlsafe 36 48)"
printf 'SESSION_SECRET=%s\n' "$(random_urlsafe 48 64)"
printf 'DATA_ENCRYPTION_KEY=%s\n' "$(openssl rand -base64 32 | tr -d '\n')"
printf 'BOOTSTRAP_TOKEN=%s\n' "$(random_urlsafe 36 48)"
