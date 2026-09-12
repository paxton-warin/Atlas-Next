#!/usr/bin/env bash
# Restore a copied startup entrypoint only. The rehearsal reproduces the old defect.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
TARGET="${1:?Usage: ./ROLLBACK.sh path/to/copied-index.mjs}"
ORIGINAL="$ROOT/evidence/ui-refinement/original/server/index.mjs"
BASELINE_HASH=215727d7ee8e42fd6079fb4646f91cbcaff67e148747cfde37156949aa2fdddc
MODIFIED_HASH=a9c46b48b2bfab305450f45262f339bd40c52cedd9c357c47b772c10e88d141d
[ -f "$TARGET" ] && [ ! -L "$TARGET" ]
[ "$(shasum -a 256 "$ORIGINAL" | awk '{print $1}')" = "$BASELINE_HASH" ]
CURRENT="$(shasum -a 256 "$TARGET" | awk '{print $1}')"
[ "$CURRENT" = "$MODIFIED_HASH" ] || [ "$CURRENT" = "$BASELINE_HASH" ]
cp "$ORIGINAL" "$TARGET"
[ "$(shasum -a 256 "$TARGET" | awk '{print $1}')" = "$BASELINE_HASH" ]
echo 'ROLLBACK_HASH_MATCH=YES'
