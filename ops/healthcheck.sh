#!/usr/bin/env bash
# 例行健康检查。安装到 /srv/example-blog/ops/healthcheck.sh，由
# example-health.timer 每 15 分钟调用一次。
#
# 检查：站点/入口/release.json 可访问、未知路径真实 404、认证服务就绪且近期无
# 5xx、认证 unit 处于 active、证书剩余天数、根分区占用、active release 与线上
# release.json 一致。成功时只写一行日志；任一失败则非零退出、写 state/health.json
# 并落到 journal（systemd 会让 unit 进入 failed，便于 systemctl --failed 发现）。
#
# 说明：本站目前没有邮件/推送通道，告警依靠 journal + state/health.json；
# 本地维护时读该文件即可（见 BLOG-MAINTAIN-PERFECT.md §10.3/§16.5）。
set -uo pipefail

SITE="${SITE_URL:-https://example.com}"
DEPLOY_ROOT="${DEPLOY_ROOT:-/srv/example-blog}"
AUTH_OPS_DIR="${AUTH_OPS_DIR:-/srv/example-blog-auth/ops}"
AUTH_UNIT="${AUTH_UNIT:-example-auth}"
STATE_DIR="$DEPLOY_ROOT/state"
STATE_FILE="$STATE_DIR/health.json"
CERT_PATH="${CERT_PATH:-/etc/nginx/tls/cert.pem}"
CERT_MIN_DAYS="${CERT_MIN_DAYS:-14}"
DISK_MAX_PERCENT="${DISK_MAX_PERCENT:-85}"
AUTH_5XX_MAX_PER_HOUR="${AUTH_5XX_MAX_PER_HOUR:-3}"

fails=()
notes=()
add_note() { notes+=("$1"); }
add_fail() { fails+=("$1"); }

http_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$1" 2>/dev/null; }

check_http() { # path expected
  local code
  code="$(http_code "$SITE$1")"
  code="${code:-000}"
  if [ "$code" = "$2" ]; then add_note "http $1=$code"; else add_fail "http $1=$code（期望 $2）"; fi
}

# 1. 站点与入口
check_http "/" 200
check_http "/lab/" 200
check_http "/release.json" 200
check_http "/__healthcheck_missing__/" 404

# 2. 认证服务就绪（unix socket readiness）
if [ -x "$AUTH_OPS_DIR/healthcheck.sh" ]; then
  if out="$("$AUTH_OPS_DIR/healthcheck.sh" 2>&1)"; then add_note "auth ready"
  else add_fail "auth readiness: ${out:-failed}"; fi
else
  add_fail "缺少 $AUTH_OPS_DIR/healthcheck.sh"
fi

# 3. 认证 unit 状态与最近一小时的 5xx
state="$(systemctl is-active "$AUTH_UNIT" 2>/dev/null || true)"
if [ "$state" = "active" ]; then add_note "auth unit active"; else add_fail "auth unit=$state"; fi
if command -v journalctl >/dev/null 2>&1; then
  recent_5xx="$(journalctl -u "$AUTH_UNIT" --since "-1 hour" --no-pager 2>/dev/null | grep -cE 'status=5[0-9][0-9]' || true)"
  if [ "${recent_5xx:-0}" -gt "$AUTH_5XX_MAX_PER_HOUR" ]; then
    add_fail "auth 近一小时 5xx=$recent_5xx（阈值 $AUTH_5XX_MAX_PER_HOUR）"
  else
    add_note "auth 近一小时 5xx=$recent_5xx"
  fi
fi

# 4. 证书剩余天数
if [ -r "$CERT_PATH" ]; then
  end="$(openssl x509 -enddate -noout -in "$CERT_PATH" 2>/dev/null | cut -d= -f2)"
  if [ -n "$end" ]; then
    days=$(( ($(date -d "$end" +%s) - $(date +%s)) / 86400 ))
    if [ "$days" -lt "$CERT_MIN_DAYS" ]; then add_fail "证书剩余 ${days} 天（阈值 ${CERT_MIN_DAYS}）"
    else add_note "证书剩余 ${days} 天"; fi
  else
    add_fail "无法读取证书到期时间：$CERT_PATH"
  fi
else
  add_fail "证书不可读：$CERT_PATH"
fi

# 5. 根分区占用
used="$(df -P / | awk 'NR==2 {gsub(/%/,"",$5); print $5}')"
if [ -n "$used" ] && [ "$used" -lt "$DISK_MAX_PERCENT" ]; then add_note "根分区 ${used}%"
else add_fail "根分区 ${used:-未知}%（阈值 ${DISK_MAX_PERCENT}）"; fi

# 6. active release 与线上 release.json 一致
active="$(readlink -f "$DEPLOY_ROOT/active" 2>/dev/null || true)"
online="$(curl -s --max-time 10 "$SITE/release.json" 2>/dev/null | grep -o '"releaseId"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
if [ -n "$active" ] && [ -n "$online" ] && [ "$(basename "$active")" = "$online" ]; then
  add_note "release=$online"
else
  add_fail "release 不一致：active=$(basename "${active:-none}") online=${online:-none}"
fi

# 7. 记录状态
mkdir -p "$STATE_DIR"
stamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
json_notes="$(printf '%s\n' "${notes[@]:-}" | sed '/^$/d' | awk '{printf "%s\"%s\"", (NR>1?",":""), $0}')"
json_fails="$(printf '%s\n' "${fails[@]:-}" | sed '/^$/d' | awk '{gsub(/\\/,"\\\\"); gsub(/"/,"\\\""); printf "%s\"%s\"", (NR>1?",":""), $0}')"
printf '{"checkedAt":"%s","site":"%s","ok":%s,"notes":[%s],"failures":[%s]}\n' \
  "$stamp" "$SITE" "$([ ${#fails[@]} -eq 0 ] && echo true || echo false)" "$json_notes" "$json_fails" > "$STATE_FILE"

if [ "${#fails[@]}" -gt 0 ]; then
  logger -t example-health "FAIL ${fails[*]}" 2>/dev/null || true
  printf 'health check FAILED at %s\n' "$stamp"
  printf '  - %s\n' "${fails[@]}"
  exit 1
fi
logger -t example-health "ok ${notes[*]}" 2>/dev/null || true
printf 'health check ok at %s（%s）\n' "$stamp" "${notes[*]}"
