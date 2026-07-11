#!/usr/bin/env bash
# One-time migration to the conversation-scoped extension layout.
# See src/harness/extensions/LAYOUT.md. Idempotent; safe to re-run.
#
#   sudo STATE_DIR=/root/.mikan bash migrate-extension-layout.sh [--apply]
#
# Without --apply it prints the moves (dry run). Conversation ids are kept
# verbatim (no case change).
set -euo pipefail

STATE_DIR="${STATE_DIR:-$HOME/.mikan}"
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

run() {
  echo "  $*"
  if [ "$APPLY" = "1" ]; then "$@"; fi
}

move() {
  local src="$1" dst="$2"
  [ -e "$src" ] || return 0
  run mkdir -p "$(dirname "$dst")"
  run mv "$src" "$dst"
}

echo "State dir: $STATE_DIR   (mode: $([ "$APPLY" = 1 ] && echo APPLY || echo DRY-RUN))"

# 1. global extension code:  extensions/global/<slug>  ->  global/extensions/<slug>
if [ -d "$STATE_DIR/extensions/global" ]; then
  for path in "$STATE_DIR"/extensions/global/*; do
    [ -e "$path" ] || continue
    move "$path" "$STATE_DIR/global/extensions/$(basename "$path")"
  done
fi

# 2. per-conversation extension code:  extensions/<id>/<slug>  ->  conversations/<id>/extensions/<slug>
if [ -d "$STATE_DIR/extensions" ]; then
  for conv in "$STATE_DIR"/extensions/*; do
    [ -d "$conv" ] || continue
    id="$(basename "$conv")"
    [ "$id" = "global" ] && continue
    for path in "$conv"/*; do
      [ -e "$path" ] || continue
      move "$path" "$STATE_DIR/conversations/$id/extensions/$(basename "$path")"
    done
  done
fi

# 3. shared extension data:  extension-data/<slug>/shared  ->  global/extension-data/<slug>
# 4. per-conv extension data: extension-data/<slug>/conversations/<id> -> conversations/<id>/extension-data/<slug>
if [ -d "$STATE_DIR/extension-data" ]; then
  for slugdir in "$STATE_DIR"/extension-data/*; do
    [ -d "$slugdir" ] || continue
    slug="$(basename "$slugdir")"
    move "$slugdir/shared" "$STATE_DIR/global/extension-data/$slug"
    if [ -d "$slugdir/conversations" ]; then
      for conv in "$slugdir"/conversations/*; do
        [ -d "$conv" ] || continue
        id="$(basename "$conv")"
        move "$conv" "$STATE_DIR/conversations/$id/extension-data/$slug"
      done
    fi
  done
fi

echo "Done. Empty old dirs (extensions/, extension-data/) can be removed once verified."
echo "Then restart mikan and run /pi-new in affected conversations."
