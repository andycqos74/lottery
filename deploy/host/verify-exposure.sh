#!/usr/bin/env bash
# Prove that only what should be reachable is reachable.
#
# Run this from a machine OUTSIDE the VPS. Checking from the box itself proves
# nothing — loopback bindings look open from inside and shut from outside, which
# is exactly the distinction that matters here.
#
#   deploy/host/verify-exposure.sh 203.0.113.10 [ssh-port]
set -euo pipefail

HOST="${1:?usage: verify-exposure.sh <public-ip-or-host> [ssh-port]}"
SSH_PORT="${2:-22}"

# Everything that MUST NOT be reachable from the internet. Each of these being
# open would be a serious finding, so they are named rather than scanned for.
declare -A FORBIDDEN=(
  [5432]="postgres-app — THE LEDGER"
  [5433]="postgres-temporal"
  [7233]="Temporal frontend gRPC"
  [7234]="Temporal history"
  [7235]="Temporal matching"
  [7239]="Temporal internal worker"
  [6933]="Temporal membership (ringpop)"
  [8080]="api (must be behind Caddy)"
  [8081]="admin console (must be behind Caddy)"
  [8082]="codec server (must be behind Caddy)"
  [8025]="mailpit"
  [9090]="sandbox-providers — DUMMY PROVIDERS"
  [2375]="Docker daemon (unauthenticated)"
  [2376]="Docker daemon (TLS)"
)

fail=0
echo "Checking ${HOST} from outside..."
echo ""
echo "Expected open:"
for port in 443 "${SSH_PORT}"; do
  if timeout 5 bash -c "</dev/tcp/${HOST}/${port}" 2>/dev/null; then
    echo "  ✓ ${port} open"
  else
    echo "  ✗ ${port} CLOSED — expected open. Is the stack up? Is your IP in ADMIN_ALLOWED_CIDRS?"
    fail=1
  fi
done

echo ""
echo "Expected closed:"
for port in "${!FORBIDDEN[@]}"; do
  if timeout 3 bash -c "</dev/tcp/${HOST}/${port}" 2>/dev/null; then
    echo "  ✗ ${port} OPEN — ${FORBIDDEN[$port]}"
    fail=1
  else
    echo "  ✓ ${port} closed  (${FORBIDDEN[$port]})"
  fi
done

echo ""
if [[ ${fail} -eq 0 ]]; then
  echo "Exposure is as designed: 443 and SSH only."
else
  echo "EXPOSURE CHECK FAILED. Do not put real member data on this host until it passes."
  exit 1
fi
