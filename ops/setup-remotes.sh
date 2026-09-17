# 远端配置：上游只读，个人私人仓库为唯一真源
#
# 用法（在仓库根目录）：
#   bash ops/setup-remotes.sh git@github.com:<你的账号>/<私人仓库>.git
#
# 说明：
# - 原 origin（LBEILC/RhineLabUI）会被改名为 upstream，只用于参考，不推送。
# - 新 origin 指向私人仓库；main 跟踪 origin/main。
# - 该脚本不会执行 commit / push，只调整 remote 配置。
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "用法：bash ops/setup-remotes.sh <私人仓库URL>" >&2
  exit 1
fi

NEW_ORIGIN="$1"
UPSTREAM_URL="https://github.com/LBEILC/RhineLabUI.git"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "当前目录不是 Git 仓库。" >&2
  exit 1
fi

current_origin="$(git remote get-url origin 2>/dev/null || true)"
if [ "$current_origin" = "$UPSTREAM_URL" ] || [ "$current_origin" = "git@github.com:LBEILC/RhineLabUI.git" ]; then
  if git remote get-url upstream >/dev/null 2>&1; then
    echo "upstream 已存在，跳过重命名。"
  else
    git remote rename origin upstream
    echo "已将原 origin 重命名为 upstream（只读参考）。"
  fi
elif git remote get-url upstream >/dev/null 2>&1; then
  echo "upstream 已存在，跳过。"
else
  echo "警告：当前 origin 不是已知上游（$current_origin），未自动重命名。" >&2
  echo "请手动确认后再设置 upstream。" >&2
fi

if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$NEW_ORIGIN"
  echo "已将 origin 设置为 $NEW_ORIGIN"
else
  git remote add origin "$NEW_ORIGIN"
  echo "已添加 origin = $NEW_ORIGIN"
fi

# 明确禁止向上游推送。
if git remote get-url upstream >/dev/null 2>&1; then
  git remote set-url --push upstream DISABLED_UPSTREAM_IS_READ_ONLY
  echo "已禁用向 upstream 的推送。"
fi

echo
echo "当前远端："
git remote -v
echo
echo "下一步（需人工确认后执行）："
echo "  git add --renormalize ."
echo "  git add -A"
echo "  git commit -m 'chore: personal blog workspace (S1)'"
echo "  git push -u origin main"
