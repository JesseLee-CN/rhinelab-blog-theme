#!/usr/bin/env bash
# 服务器端解包：校验上传的归档并生成不可变 release。不编译、不安装依赖。
set -euo pipefail
umask 077

RELEASE_ID="${1:-}"
[ -n "$RELEASE_ID" ] || { echo "用法：prepare-release.sh <release-id>" >&2; exit 1; }
case "$RELEASE_ID" in
  */*|*..*|"") echo "非法 release ID：$RELEASE_ID" >&2; exit 1 ;;
esac

DEPLOY_ROOT="${DEPLOY_ROOT:-/srv/example-blog}"
RELEASES_DIR="${RELEASES_DIR:-$DEPLOY_ROOT/releases}"
INCOMING="${DEPLOY_ROOT}/incoming/${RELEASE_ID}"
RELEASE_DIR="$RELEASES_DIR/$RELEASE_ID"

log() { printf '[prepare] %s\n' "$*"; }

for tool in tar sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || { echo "缺少 $tool" >&2; exit 1; }
done

[ -d "$INCOMING" ] || { echo "上传目录不存在：$INCOMING" >&2; exit 1; }
[ -f "$INCOMING/site.tar.gz" ] || { echo "缺少 site.tar.gz" >&2; exit 1; }
[ -f "$INCOMING/checksums.sha256" ] || { echo "缺少 checksums.sha256" >&2; exit 1; }

if [ -e "$RELEASE_DIR" ]; then
  echo "release 已存在，拒绝覆盖：$RELEASE_DIR" >&2
  exit 1
fi

log "校验 sha256"
( cd "$INCOMING" && sha256sum -c checksums.sha256 )

log "解包到 $RELEASE_DIR/site"
mkdir -p "$RELEASE_DIR/site"
# 首次创建时 umask 077 会让 releases/ 不可被 Web 用户遍历，显式放开。
chmod 0755 "$RELEASES_DIR"
# 拒绝绝对路径与越界条目。
tar -tzf "$INCOMING/site.tar.gz" | while IFS= read -r entry; do
  case "$entry" in
    /*|*..*) echo "归档包含越界条目：$entry" >&2; exit 1 ;;
  esac
done
tar -xzf "$INCOMING/site.tar.gz" -C "$RELEASE_DIR/site"

[ -f "$RELEASE_DIR/site/index.html" ] || { echo "解包后缺少 index.html" >&2; exit 1; }
[ -f "$RELEASE_DIR/site/lab/index.html" ] || { echo "解包后缺少 lab/index.html" >&2; exit 1; }

if [ -f "$INCOMING/release-manifest.json" ]; then
  cp "$INCOMING/release-manifest.json" "$RELEASE_DIR/release-manifest.json"
  # 无秘密的发布标识，供线上核验当前 release（不含路径/凭据）。
  cp "$INCOMING/release-manifest.json" "$RELEASE_DIR/site/release.json"
fi
mkdir -p "$RELEASE_DIR/nginx"
if [ -d "$INCOMING/nginx" ]; then
  cp -a "$INCOMING/nginx/." "$RELEASE_DIR/nginx/"
fi

# Web 服务需要能遍历 release 目录并读取静态文件；release 元数据仍仅 root 可读。
chown -R root:root "$RELEASE_DIR"
chmod 755 "$RELEASE_DIR"
chmod -R a+rX "$RELEASE_DIR/site" "$RELEASE_DIR/nginx"
log "release 就绪：$RELEASE_DIR"
log "下一步：DEPLOY_ROOT=$DEPLOY_ROOT bash activate-release.sh $RELEASE_ID"
