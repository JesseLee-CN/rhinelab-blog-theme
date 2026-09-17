#!/usr/bin/env bash
# 服务器初始化（轻量）：只准备接收与激活 release 所需的最小环境。
# 不安装 Node/npm，不克隆仓库，不编译。构建在本机完成。
#
# 默认 dry-run。S0 核实环境后执行：
#   1) 本机把 ops/ 上传到服务器临时目录，例如：
#        scp -r ops root@203.0.113.10:/tmp/example-ops
#   2) 服务器执行：
#        bash /tmp/example-ops/server-bootstrap.sh --apply
set -euo pipefail
umask 077

APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

DEPLOY_ROOT="${DEPLOY_ROOT:-/srv/example-blog}"
DEPLOY_USER="${DEPLOY_USER:-deploy}"
OPS_SOURCE="${OPS_SOURCE:-/tmp/example-ops}"

log() { printf '[bootstrap] %s\n' "$*"; }
run() {
  if [ "$APPLY" -eq 1 ]; then "$@"; else printf '[dry-run] %s\n' "$*"; fi
}

if [ "$APPLY" -eq 1 ] && [ "$(id -u)" -ne 0 ]; then
  echo "请以 root 运行 --apply（或使用已授权的方式）。" >&2
  exit 1
fi

log "DEPLOY_ROOT=$DEPLOY_ROOT  DEPLOY_USER=$DEPLOY_USER"

# 1. 最小依赖：解包、校验、健康检查。不需要 Node。
if command -v apt-get >/dev/null 2>&1; then
  run apt-get update
  run apt-get install -y --no-install-recommends ca-certificates curl rsync tar
else
  log "非 apt 系统，请按 S0 结果手动确保 curl、rsync、tar、sha256sum 可用"
fi

# 2. 目录。
run mkdir -p "$DEPLOY_ROOT/releases" "$DEPLOY_ROOT/incoming" "$DEPLOY_ROOT/state" "$DEPLOY_ROOT/ops"

# 3. 安装受信任的 ops 脚本（root 拥有、deploy 不可写）。
if [ -d "$OPS_SOURCE" ]; then
  for script in prepare-release.sh activate-release.sh rollback-release.sh; do
    if [ ! -f "$OPS_SOURCE/$script" ]; then
      echo "缺少 $OPS_SOURCE/$script" >&2
      exit 1
    fi
    run install -m 700 -o root -g root "$OPS_SOURCE/$script" "$DEPLOY_ROOT/ops/$script"
  done
  log "已安装 ops 脚本到 $DEPLOY_ROOT/ops（root:root 0700）"
else
  log "未找到 $OPS_SOURCE；请先把 ops/ 上传到该目录再重试"
fi

# 4. 可选：受限 deploy 用户（仅用于上传 incoming 与调用 helper）。
if id "$DEPLOY_USER" >/dev/null 2>&1; then
  log "已存在用户 $DEPLOY_USER"
else
  log "用户 $DEPLOY_USER 不存在；如需受限发布身份，请按 S0 结果创建（adduser --system --group $DEPLOY_USER）"
fi

log "完成。下一步："
log "  1) 本机填写 ops/upload.env（服务器地址/端口/私钥路径）"
log "  2) 本机 ops/deploy.env 由服务器管理员按 S0 结果填写到 $DEPLOY_ROOT/ops/deploy.env"
log "  3) 本机构建并打包：npm ci && npm run build && npm run release -- --id <release-id>"
log "  4) 上传：ops/upload-release.sh --id <release-id> --activate（或 Windows 的 upload-release.ps1）"
