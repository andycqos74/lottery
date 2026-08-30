#!/usr/bin/env bash
# Temporal schema, namespace, and search attributes.
#
# T-10.6: "The exact temporal-sql-tool flags and schema paths shift between
# releases. Verify against the pinned admin-tools version before running, and
# script the result — this command is run again at every server upgrade, so it
# must be in version control, not in someone's shell history."
#
# This IS that script. Idempotent: safe to re-run, and re-run it after every
# Temporal version bump.
set -euo pipefail

cd "$(dirname "$0")/.."
source compose/images.env

NAMESPACE="${TEMPORAL_NAMESPACE:-qosfc-lottery}"
# TG-10: 30 days is a SUGGESTION and needs confirming. Workflow history is an
# orchestration log; statutory and GDPR record retention are years and live in
# PostgreSQL (T-1.1). Do not conflate them.
RETENTION="${TEMPORAL_RETENTION:-30d}"
NETWORK="qosfc-lottery_core"
PW="$(cat secrets/temporal_db_password)"

echo "── 1. Schema ──────────────────────────────────────────────────────────────"
docker run --rm --network "${NETWORK}" \
  -e SQL_PLUGIN=postgres12 \
  -e SQL_HOST=postgres-temporal -e SQL_PORT=5432 \
  -e SQL_USER=temporal -e SQL_PASSWORD="${PW}" \
  "${TEMPORAL_ADMIN_IMAGE}" sh -c '
    set -e
    temporal-sql-tool --database temporal create-database || true
    temporal-sql-tool --database temporal setup-schema -v 0.0 || true
    temporal-sql-tool --database temporal update-schema \
      -d ./schema/postgresql/v12/temporal/versioned
    temporal-sql-tool --database temporal_visibility create-database || true
    temporal-sql-tool --database temporal_visibility setup-schema -v 0.0 || true
    temporal-sql-tool --database temporal_visibility update-schema \
      -d ./schema/postgresql/v12/visibility/versioned'

echo "── 2. Namespace ───────────────────────────────────────────────────────────"
docker run --rm --network "${NETWORK}" "${TEMPORAL_ADMIN_IMAGE}" \
  temporal operator namespace create \
    --address temporal:7233 --namespace "${NAMESPACE}" --retention "${RETENTION}" \
  2>&1 | grep -v "already exists" || true

echo "── 3. Search attributes ───────────────────────────────────────────────────"
# T-10.7: namespace-scoped on SQL-backed visibility, and workflow code that sets
# an unregistered attribute fails at RUNTIME. Registering them is provisioning,
# not an afterthought — the worker asserts their presence at startup.
docker run --rm --network "${NETWORK}" "${TEMPORAL_ADMIN_IMAGE}" \
  temporal operator search-attribute create \
    --address temporal:7233 --namespace "${NAMESPACE}" \
    --name DrawNumber      --type Int \
    --name DrawStatus      --type Keyword \
    --name MemberNumber    --type Int \
    --name MemberStatus    --type Keyword \
    --name StatementNumber --type Int \
    --name TaskKind        --type Keyword \
    --name Blocked         --type Bool \
    --name AmountPence     --type Int \
  2>&1 | grep -v "already exists" || true

echo ""
echo "Done. Verify with: pnpm verify:stack"
