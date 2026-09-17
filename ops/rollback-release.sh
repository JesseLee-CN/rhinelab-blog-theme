#!/usr/bin/env bash
# 回滚到指定的已验证 release。只切换 active 指针并重载，不修改任何 release 内容。
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
[ -f "$SCRIPT_DIR/deploy.env" ] && source "$SCRIPT_DIR/deploy.env"

RELEASE_ID="${1:-}"
[ -n "$RELEASE_ID" ] || { echo "用法：rollback-release.sh <release-id>" >&2; exit 1; }

DEPLOY_ROOT="${DEPLOY_ROOT:-/srv/example-blog}"
RELEASES_DIR="${RELEASES_DIR:-$DEPLOY_ROOT/releases}"
STATE_DIR="${STATE_DIR:-$DEPLOY_ROOT/state}"
HEALTHCHECK_URL="${HEALTHCHECK_URL:-}"
CONFIG_TEST_CMD="${CONFIG_TEST_CMD:-}"
RELOAD_CMD="${RELOAD_CMD:-}"

RELEASE_DIR="$RELEASES_DIR/$RELEASE_ID"
[ -d "$RELEASE_DIR/site" ] || { echo "release 不存在：$RELEASE_DIR/site" >&2; exit 1; }
[ -f "$RELEASE_DIR/site/index.html" ] || { echo "release 缺少 index.html" >&2; exit 1; }

mkdir -p "$STATE_DIR"
lock="$STATE_DIR/activate.lock"
exec 9>"$lock"
flock -n 9 || { echo "已有激活/回滚操作在进行。" >&2; exit 1; }

log() { printf '[rollback] %s\n' "$*"; }

current="$(readlink -f "$DEPLOY_ROOT/active" 2>/dev/null || true)"
log "当前 active：${current:-（无）}，回滚目标：$RELEASE_ID"

ln -sfn "$RELEASE_DIR" "$DEPLOY_ROOT/.active.tmp"
mv -T "$DEPLOY_ROOT/.active.tmp" "$DEPLOY_ROOT/active"

if [ -n "$CONFIG_TEST_CMD" ]; then
  log "配置测试：$CONFIG_TEST_CMD"
  sh -c "$CONFIG_TEST_CMD" || { echo "[rollback][error] 配置测试失败，请人工处理。" >&2; exit 1; }
fi
if [ -n "$RELOAD_CMD" ]; then
  log "重载：$RELOAD_CMD"
  sh -c "$RELOAD_CMD" || { echo "[rollback][error] 重载失败，请人工处理。" >&2; exit 1; }
fi

if [ -n "$HEALTHCHECK_URL" ]; then
  for i in 1 2 3 4 5; do
    if curl -fsS --max-time 5 "$HEALTHCHECK_URL" >/dev/null 2>&1; then
      log "回滚健康检查通过。"
      [ -n "$current" ] && echo "$(basename "$current")" >"$STATE_DIR/previous-release.txt"
      log "回滚完成：$RELEASE_ID"
      exit 0
    fi
    sleep 1
  done
  echo "[rollback][error] 回滚后健康检查仍失败，需要人工介入。" >&2
  exit 1
fi

[ -n "$current" ] && echo "$(basename "$current")" >"$STATE_DIR/previous-release.txt"
log "回滚完成（未配置健康检查）：$RELEASE_ID"
