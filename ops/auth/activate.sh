#!/usr/bin/env bash
# Activate an auth release atomically, verify readiness, and revert on failure.
# Run as root. Does not touch the static site or nginx config.
set -euo pipefail

RELEASE_ROOT="" ID="" SERVICE="example-auth"
HERE="$(cd "$(dirname "$0")" && pwd)"
while [ $# -gt 0 ]; do
  case "$1" in
    --release-root) RELEASE_ROOT="$2"; shift 2 ;;
    --id) ID="$2"; shift 2 ;;
    --service) SERVICE="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$RELEASE_ROOT" ] || [ -z "$ID" ]; then
  echo "usage: activate.sh --release-root <dir> --id <id> [--service <name>]" >&2
  exit 2
fi

TARGET="$RELEASE_ROOT/$ID"
LINK="$RELEASE_ROOT/current"
STATE_DIR="$RELEASE_ROOT/state"
[ -x "$TARGET/lab-auth" ] || { echo "release not prepared: $TARGET" >&2; exit 1; }

PREV=""
if [ -L "$LINK" ]; then PREV="$(basename "$(readlink "$LINK")")"; fi
if [ -n "$PREV" ]; then
  mkdir -p "$STATE_DIR"
  printf '%s\n' "$PREV" > "$STATE_DIR/previous"
fi

ln -sfn "$TARGET" "$LINK.next"
mv -Tf "$LINK.next" "$LINK"
systemctl restart "$SERVICE" 2>/dev/null || true

if "$HERE/healthcheck.sh"; then
  mkdir -p "$STATE_DIR"
  printf '%s\n' "$ID" > "$STATE_DIR/active"
  echo "activated $ID (previous: ${PREV:-none})"
  exit 0
fi

echo "health check failed; reverting" >&2
if [ -n "$PREV" ] && [ -x "$RELEASE_ROOT/$PREV/lab-auth" ]; then
  ln -sfn "$RELEASE_ROOT/$PREV" "$LINK.next"
  mv -Tf "$LINK.next" "$LINK"
  systemctl restart "$SERVICE" 2>/dev/null || true
  "$HERE/healthcheck.sh" || echo "warning: previous release also not ready" >&2
fi
exit 1
