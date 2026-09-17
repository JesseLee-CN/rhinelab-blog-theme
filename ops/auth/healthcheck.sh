#!/usr/bin/env bash
# Readiness check over the unix socket. Non-zero when not ready.
set -euo pipefail
SOCKET="${LAB_AUTH_SOCKET:-/run/example-blog-auth/http.sock}"
TRIES="${LAB_AUTH_HEALTH_TRIES:-20}"
for _ in $(seq 1 "$TRIES"); do
  if curl -fsS --unix-socket "$SOCKET" http://localhost/health/ready >/dev/null 2>&1; then
    echo "ready"
    exit 0
  fi
  sleep 0.5
done
echo "auth service not ready on $SOCKET" >&2
exit 1
