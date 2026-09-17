#!/usr/bin/env bash
# Unpack a verified auth release into an immutable directory. Run as root.
set -euo pipefail

TARBALL="" RELEASE_ROOT="" ID="" CHECKSUM=""
while [ $# -gt 0 ]; do
  case "$1" in
    --tarball) TARBALL="$2"; shift 2 ;;
    --release-root) RELEASE_ROOT="$2"; shift 2 ;;
    --id) ID="$2"; shift 2 ;;
    --checksum) CHECKSUM="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$TARBALL" ] || [ -z "$RELEASE_ROOT" ] || [ -z "$ID" ]; then
  echo "usage: prepare.sh --tarball <file> --release-root <dir> --id <id> [--checksum <sha256>]" >&2
  exit 2
fi
[ -f "$TARBALL" ] || { echo "missing tarball: $TARBALL" >&2; exit 1; }

if [ -n "$CHECKSUM" ]; then
  echo "$CHECKSUM  $TARBALL" | sha256sum -c - >/dev/null || { echo "checksum mismatch" >&2; exit 1; }
fi
if tar -tzf "$TARBALL" | grep -E '(^/|(^|/)\.\.(/|$))' >/dev/null; then
  echo "archive contains an unsafe path" >&2
  exit 1
fi

DEST="$RELEASE_ROOT/$ID"
[ ! -e "$DEST" ] || { echo "release already exists: $DEST" >&2; exit 1; }
mkdir -p "$RELEASE_ROOT"
TMP="$(mktemp -d "$RELEASE_ROOT/.incoming.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
tar -xzf "$TARBALL" -C "$TMP"
[ -f "$TMP/lab-auth" ] || { echo "archive missing lab-auth" >&2; exit 1; }
[ -f "$TMP/manifest.json" ] || { echo "archive missing manifest.json" >&2; exit 1; }
chmod 0755 "$TMP/lab-auth"
mv "$TMP" "$DEST"
trap - EXIT
echo "prepared $DEST"
