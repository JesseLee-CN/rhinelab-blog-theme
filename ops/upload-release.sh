#!/usr/bin/env bash
# 本地上传：把 scripts/blog/package-release.mjs 生成的不可变 release 通过 SSH 传到服务器。
# 构建发生在本机；服务器只接收、校验、解包并激活，不安装 Node、不编译。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=/dev/null
[ -f "$SCRIPT_DIR/upload.env" ] && source "$SCRIPT_DIR/upload.env"

SSH_HOST="${SSH_HOST:-}"
SSH_USER="${SSH_USER:-root}"
SSH_PORT="${SSH_PORT:-22}"
SSH_IDENTITY="${SSH_IDENTITY:-}"
DEPLOY_ROOT="${DEPLOY_ROOT:-/srv/example-blog}"
RELEASE_ID=""
ACTIVATE=0
DRY_RUN=0

usage() {
  cat <<'EOF'
用法：ops/upload-release.sh --id <release-id> [选项]
  --host <addr>       服务器地址（或 upload.env 的 SSH_HOST）
  --user <name>       SSH 用户（默认 root；生产建议受限 deploy 用户）
  --port <n>          SSH 端口（默认 22）
  --identity <file>   SSH 私钥路径（可选）
  --deploy-root <dir> 服务器 release 根（默认 /srv/example-blog）
  --activate          上传校验后运行 prepare-release.sh + activate-release.sh
  --dry-run           只打印将执行的命令
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --id) RELEASE_ID="$2"; shift 2 ;;
    --host) SSH_HOST="$2"; shift 2 ;;
    --user) SSH_USER="$2"; shift 2 ;;
    --port) SSH_PORT="$2"; shift 2 ;;
    --identity) SSH_IDENTITY="$2"; shift 2 ;;
    --deploy-root) DEPLOY_ROOT="$2"; shift 2 ;;
    --activate) ACTIVATE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数：$1" >&2; usage; exit 1 ;;
  esac
done

[ -n "$SSH_HOST" ] || { echo "缺少 --host 或 upload.env 的 SSH_HOST。" >&2; exit 1; }
[ -n "$RELEASE_ID" ] || { echo "缺少 --id。" >&2; usage; exit 1; }
[ "$RELEASE_ID" != "${RELEASE_ID#/}" ] || true
case "$RELEASE_ID" in
  */*|*..*|"") echo "非法 release ID：$RELEASE_ID" >&2; exit 1 ;;
esac

LOCAL_DIR="$REPO_ROOT/release/$RELEASE_ID"
[ -f "$LOCAL_DIR/site.tar.gz" ] || { echo "本地缺少归档：$LOCAL_DIR/site.tar.gz（先运行 npm run release -- --id $RELEASE_ID）" >&2; exit 1; }
[ -f "$LOCAL_DIR/checksums.sha256" ] || { echo "本地缺少 checksums.sha256" >&2; exit 1; }
[ -f "$LOCAL_DIR/release-manifest.json" ] || { echo "本地缺少 release-manifest.json" >&2; exit 1; }

SSH_OPTS=(-p "$SSH_PORT" -o BatchMode=yes -o StrictHostKeyChecking=yes)
[ -n "$SSH_IDENTITY" ] && SSH_OPTS+=(-i "$SSH_IDENTITY")
REMOTE="${SSH_USER}@${SSH_HOST}"
INCOMING="${DEPLOY_ROOT}/incoming/${RELEASE_ID}"
OPS_DIR="${DEPLOY_ROOT}/ops"

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] %s\n' "$*"
  else
    "$@"
  fi
}
run_ssh() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] ssh %s %s %s\n' "${SSH_OPTS[*]}" "$REMOTE" "$1"
  else
    ssh "${SSH_OPTS[@]}" "$REMOTE" "$1"
  fi
}

echo "[upload] $RELEASE_ID -> $REMOTE:$INCOMING"
run_ssh "mkdir -p '$INCOMING'"

FILES=("$LOCAL_DIR/site.tar.gz" "$LOCAL_DIR/release-manifest.json" "$LOCAL_DIR/checksums.sha256")
[ -d "$LOCAL_DIR/nginx" ] && FILES+=("$LOCAL_DIR/nginx")

if command -v rsync >/dev/null 2>&1; then
  RSYNC_SSH="ssh -p $SSH_PORT -o BatchMode=yes -o StrictHostKeyChecking=yes"
  [ -n "$SSH_IDENTITY" ] && RSYNC_SSH="$RSYNC_SSH -i $SSH_IDENTITY"
  run rsync -az -e "$RSYNC_SSH" "${FILES[@]}" "$REMOTE:$INCOMING/"
else
  run scp -r "${SSH_OPTS[@]}" "${FILES[@]}" "$REMOTE:$INCOMING/"
fi

echo "[upload] 服务器校验 sha256"
run_ssh "cd '$INCOMING' && sha256sum -c checksums.sha256"

if [ "$ACTIVATE" -eq 1 ]; then
  echo "[upload] 解包并激活"
  run_ssh "DEPLOY_ROOT='$DEPLOY_ROOT' bash '$OPS_DIR/prepare-release.sh' '$RELEASE_ID'"
  run_ssh "DEPLOY_ROOT='$DEPLOY_ROOT' bash '$OPS_DIR/activate-release.sh' '$RELEASE_ID'"
  echo "[upload] 激活命令已完成；请再用 ops/smoke-test.mjs 验证线上。"
else
  echo "[upload] 上传与校验完成。激活："
  echo "  ssh ${SSH_OPTS[*]} $REMOTE \"DEPLOY_ROOT=$DEPLOY_ROOT bash $OPS_DIR/prepare-release.sh $RELEASE_ID && DEPLOY_ROOT=$DEPLOY_ROOT bash $OPS_DIR/activate-release.sh $RELEASE_ID\""
fi
