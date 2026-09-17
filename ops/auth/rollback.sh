#!/usr/bin/env bash
# Roll back to the release recorded before the current one. Refuses to run
# without a known target so a broken state is never "rolled back" blindly.
set -euo pipefail

RELEASE_ROOT="" SERVICE="example-auth"
HERE="$(cd "$(dirname "$0")" && pwd)"
while [ $# -gt 0 ]; do
  case "$1" in
    --release-root) RELEASE_ROOT="$2"; shift 2 ;;
    --service) SERVICE="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$RELEASE_ROOT" ]; then
  echo "usage: rollback.sh --release-root <dir> [--service <name>]" >&2
  exit 2
fi

CURRENT="$RELEASE_ROOT/state/active"
PREVIOUS="$RELEASE_ROOT/state/previous"
[ -f "$CURRENT" ] || { echo "no active release recorded" >&2; exit 1; }
[ -f "$PREVIOUS" ] || { echo "no previous release recorded" >&2; exit 1; }

ACTIVE="$(cat "$CURRENT")"
TARGET="$(cat "$PREVIOUS")"
echo "rolling back $ACTIVE -> $TARGET"
"$HERE/activate.sh" --release-root "$RELEASE_ROOT" --id "$TARGET" --service "$SERVICE"
printf '%s\n' "$ACTIVE" > "$RELEASE_ROOT/state/previous"
