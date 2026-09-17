#!/usr/bin/env bash
# 激活一个已生成的不可变 release。切换失败自动回退到上一个 active。
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
[ -f "$SCRIPT_DIR/deploy.env" ] && source "$SCRIPT_DIR/deploy.env"

RELEASE_ID="${1:-}"
[ -n "$RELEASE_ID" ] || { echo "用法：activate-release.sh <release-id>" >&2; exit 1; }

DEPLOY_ROOT="${DEPLOY_ROOT:-/srv/example-blog}"
RELEASES_DIR="${RELEASES_DIR:-$DEPLOY_ROOT/releases}"
STATE_DIR="${STATE_DIR:-$DEPLOY_ROOT/state}"
HEALTHCHECK_URL="${HEALTHCHECK_URL:-}"
CONFIG_TEST_CMD="${CONFIG_TEST_CMD:-}"
RELOAD_CMD="${RELOAD_CMD:-}"

RELEASE_DIR="$RELEASES_DIR/$RELEASE_ID"
[ -d "$RELEASE_DIR/site" ] || { echo "release 不存在：$RELEASE_DIR/site" >&2; exit 1; }
[ -f "$RELEASE_DIR/site/index.html" ] || { echo "release 缺少 index.html：$RELEASE_DIR" >&2; exit 1; }

mkdir -p "$STATE_DIR"
lock="$STATE_DIR/activate.lock"
exec 9>"$lock"
flock -n 9 || { echo "已有激活操作在进行。" >&2; exit 1; }

log() { printf '[activate] %s\n' "$*"; }

previous="$(readlink -f "$DEPLOY_ROOT/active" 2>/dev/null || true)"

swap() {
  ln -sfn "$RELEASE_DIR" "$DEPLOY_ROOT/.active.tmp"
  mv -T "$DEPLOY_ROOT/.active.tmp" "$DEPLOY_ROOT/active"
}

config_reload() {
  if [ -n "$CONFIG_TEST_CMD" ]; then
    log "配置测试：$CONFIG_TEST_CMD"
    sh -c "$CONFIG_TEST_CMD" || return 1
  else
    log "警告：未配置 CONFIG_TEST_CMD，跳过配置测试。"
  fi
  if [ -n "$RELOAD_CMD" ]; then
    log "重载：$RELOAD_CMD"
    sh -c "$RELOAD_CMD" || return 1
  else
    log "警告：未配置 RELOAD_CMD，跳过重载。"
  fi
}

healthcheck() {
  if [ -z "$HEALTHCHECK_URL" ]; then
    log "警告：未配置 HEALTHCHECK_URL，跳过健康检查。"
    return 0
  fi
  for i in 1 2 3 4 5; do
    if curl -fsS --max-time 5 "$HEALTHCHECK_URL" >/dev/null 2>&1; then
      log "健康检查通过：$HEALTHCHECK_URL"
      return 0
    fi
    sleep 1
  done
  echo "[activate][error] 健康检查失败：$HEALTHCHECK_URL" >&2
  return 1
}

rollback_to_previous() {
  if [ -n "$previous" ] && [ -d "$previous/site" ]; then
    log "回退到上一个 release：$previous"
    ln -sfn "$previous" "$DEPLOY_ROOT/.active.tmp"
    mv -T "$DEPLOY_ROOT/.active.tmp" "$DEPLOY_ROOT/active"
    config_reload || true
  else
    log "没有可回退的上一版本；保留切换前状态。"
  fi
}

log "切换 active -> $RELEASE_ID"
[ -n "$previous" ] && echo "$(basename "$previous")" >"$STATE_DIR/previous-release.txt"
swap

if ! config_reload || ! healthcheck; then
  echo "[activate][error] 新版本未通过检查，回退。" >&2
  rollback_to_previous
  exit 1
fi

log "激活成功：$RELEASE_ID"
