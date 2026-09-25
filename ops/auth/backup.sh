#!/usr/bin/env bash
# Consistent auth database backup via the verified CLI (VACUUM INTO + integrity
# check). Keeps the last N snapshots. Run as the service user or root.
set -euo pipefail

DB="" OUT_DIR="" KEEP=7 BIN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --db) DB="$2"; shift 2 ;;
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    --keep) KEEP="$2"; shift 2 ;;
    --bin) BIN="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$DB" ] || [ -z "$OUT_DIR" ]; then
  echo "usage: backup.sh --db <path> --out-dir <dir> [--keep N] [--bin lab-auth]" >&2
  exit 2
fi
BIN="${BIN:-$(command -v lab-auth || true)}"
[ -n "$BIN" ] || { echo "lab-auth binary not found" >&2; exit 1; }
mkdir -p "$OUT_DIR"
chmod 0700 "$OUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET="$OUT_DIR/auth-$STAMP.db"
"$BIN" backup -db "$DB" -out "$TARGET"
# 双保险：CLI 已写成 0600，这里再收敛一次（快照含口令散列）。
chmod 0600 "$TARGET"
# Keep the newest N snapshots.
ls -1t "$OUT_DIR"/auth-*.db 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f
echo "backup written: $TARGET"
