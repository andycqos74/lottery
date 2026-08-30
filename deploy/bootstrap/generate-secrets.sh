#!/usr/bin/env bash
# Generate every secret the stack needs. Run ONCE per environment.
#
# Secrets are files, not environment variables: an env var leaks into `docker
# inspect`, into crash dumps, and into any child process, whereas a file is
# readable only by the container it is mounted into.
#
# ⚠ deploy/secrets/ is gitignored. Back the directory up somewhere that is NOT
# this repository — losing the codec key makes existing workflow history
# permanently unreadable (TG-11 key custody).
set -euo pipefail

cd "$(dirname "$0")/.."
SECRETS_DIR="secrets"
CODEC_DIR="${SECRETS_DIR}/codec"

mkdir -p "${CODEC_DIR}"
chmod 700 "${SECRETS_DIR}"
# 0755, not 0700: ${CODEC_DIR} itself is bind-mounted whole into containers as
# the `codec_key` secret, so a container's own non-root user needs to traverse
# into it — see the note on file mode in write_secret() below.
chmod 755 "${CODEC_DIR}"

write_secret() {
  local path="$1" generator="$2" description="$3"
  if [[ -f "${path}" ]]; then
    echo "  ✓ ${path} already exists — leaving it alone (${description})"
    return
  fi
  eval "${generator}" > "${path}"
  # 0644, not 0600: Compose (outside Swarm mode) bind-mounts each secret file
  # as-is — it has no uid/gid/mode translation — so a container's own non-root
  # user (10001 for our images, the image-defined user for upstream ones like
  # Temporal) needs read access on the *file itself*. deploy/secrets/ stays
  # 0700, so only this host account can traverse into the directory at all.
  chmod 644 "${path}"
  echo "  + ${path} created (${description})"
}

echo "Generating secrets in $(pwd)/${SECRETS_DIR}"
# Base64's '+', '/' and '=' are not safe to drop unescaped into a postgres://
# URL — bootstrap-app-db.sh and every app process build one from these files.
# base64url (RFC 4648 §5) has no such characters, so there is nothing to encode
# and nothing to get wrong later by forgetting to.
URL_SAFE="tr -d '\n' | tr '+/' '-_' | tr -d '='"
write_secret "${SECRETS_DIR}/app_db_password"       "openssl rand -base64 48 | ${URL_SAFE}" "postgres-app owner password"
write_secret "${SECRETS_DIR}/temporal_db_password"  "openssl rand -base64 48 | ${URL_SAFE}" "postgres-temporal password"
write_secret "${SECRETS_DIR}/app_role_password"     "openssl rand -base64 48 | ${URL_SAFE}" "lottery_app login password"
write_secret "${SECRETS_DIR}/session_secret"        "openssl rand -base64 64 | tr -d '\n'" "cookie session signing key"
write_secret "${SECRETS_DIR}/sandbox_webhook_secret" "openssl rand -hex 32"                "sandbox webhook HMAC (dev only)"
# Encrypts app_user.totp_secret_enc at rest — deliberately separate from the
# Temporal codec key below (apps/admin/src/secret-box.ts explains why).
write_secret "${SECRETS_DIR}/admin_mfa_key"          "openssl rand -base64 32"             "admin console MFA secret-at-rest key (AES-256-GCM)"

# The codec key. AES-256-GCM needs exactly 32 bytes; the id is a date so rotation
# reads chronologically, and retired keys STAY here for decryption.
KEY_ID="${TEMPORAL_CODEC_ACTIVE_KEY_ID:-key-$(date -u +%Y%m)}"
write_secret "${CODEC_DIR}/${KEY_ID}.key" "openssl rand -base64 32" "AES-256-GCM payload key '${KEY_ID}'"

echo ""
echo "Set this in deploy/.env:"
echo "  TEMPORAL_CODEC_ACTIVE_KEY_ID=${KEY_ID}"
echo ""
echo "⚠ Back up deploy/secrets/ off this machine, encrypted."
echo "  Without ${KEY_ID}.key, existing Temporal workflow history cannot be decrypted."
