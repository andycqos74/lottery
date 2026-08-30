#!/usr/bin/env bash
# VPS hardening. Idempotent — safe to re-run after any change.
#
# Run ONCE on a fresh Ubuntu 24.04 LTS VPS, as root, BEFORE the stack goes up.
# Everything here is host-level: the container-level hardening lives in the
# compose files (no-new-privileges, cap_drop ALL, read-only rootfs, non-root uid).
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "Run as root."; exit 1; }

SSH_PORT="${SSH_PORT:-22}"
ADMIN_CIDRS="${ADMIN_ALLOWED_CIDRS:?set ADMIN_ALLOWED_CIDRS, e.g. 203.0.113.0/24}"
DEPLOY_USER="${DEPLOY_USER:-deploy}"

echo "── 1. Packages ────────────────────────────────────────────────────────────"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nftables fail2ban unattended-upgrades auditd \
                       ca-certificates curl gnupg age postgresql-client-16

echo "── 2. Automatic security updates ──────────────────────────────────────────"
# A volunteer-run box will not be patched by hand every week. Security updates
# apply themselves; everything else stays deliberate.
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
CONF
cat > /etc/apt/apt.conf.d/51qosfc-unattended <<'CONF'
Unattended-Upgrade::Allowed-Origins {
    "${distro_id}:${distro_codename}-security";
    "${distro_id}ESMApps:${distro_codename}-apps-security";
};
// Reboot for a kernel update, but at 4am — never during a Saturday draw.
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:00";
CONF

echo "── 3. Deploy user ─────────────────────────────────────────────────────────"
id -u "${DEPLOY_USER}" >/dev/null 2>&1 || useradd -m -s /bin/bash "${DEPLOY_USER}"
usermod -aG docker "${DEPLOY_USER}" 2>/dev/null || true

echo "── 4. SSH ─────────────────────────────────────────────────────────────────"
# Keys only. A password-authenticated SSH port on a public VPS is found by
# scanners within minutes of the machine existing.
cat > /etc/ssh/sshd_config.d/99-qosfc.conf <<CONF
Port ${SSH_PORT}
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PubkeyAuthentication yes
AllowUsers ${DEPLOY_USER}
X11Forwarding no
AllowAgentForwarding no
AllowTcpForwarding no
MaxAuthTries 3
ClientAliveInterval 300
ClientAliveCountMax 2
CONF
sshd -t && systemctl reload ssh

echo "── 5. Firewall (default deny inbound) ─────────────────────────────────────"
# 443 is the only thing the world sees. SSH is restricted to the admin CIDRs.
# Postgres and the Temporal frontend are bound to loopback or an internal docker
# network and appear nowhere in this ruleset — by design.
{
  echo '#!/usr/sbin/nft -f'
  echo 'flush ruleset'
  echo 'table inet filter {'
  echo '  chain input {'
  echo '    type filter hook input priority 0; policy drop;'
  echo '    ct state established,related accept'
  echo '    ct state invalid drop'
  echo '    iif lo accept'
  echo '    ip protocol icmp icmp type { echo-request, destination-unreachable, time-exceeded } accept'
  echo '    ip6 nexthdr icmpv6 accept'
  for cidr in ${ADMIN_CIDRS}; do
    echo "    ip saddr ${cidr} tcp dport ${SSH_PORT} accept"
  done
  echo '    tcp dport { 80, 443 } accept'
  echo '    udp dport 443 accept'
  echo '    limit rate 5/minute log prefix "nft-drop: "'
  echo '  }'
  echo '  chain forward { type filter hook forward priority 0; policy accept; }'
  echo '  chain output  { type filter hook output  priority 0; policy accept; }'
  echo '}'
} > /etc/nftables.conf
chmod 755 /etc/nftables.conf
systemctl enable --now nftables
nft -f /etc/nftables.conf

echo "── 6. fail2ban ────────────────────────────────────────────────────────────"
cat > /etc/fail2ban/jail.d/qosfc.conf <<CONF
[sshd]
enabled = true
port    = ${SSH_PORT}
maxretry = 3
bantime  = 1h
findtime = 10m
CONF
systemctl enable --now fail2ban

echo "── 7. Docker daemon ───────────────────────────────────────────────────────"
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'CONF'
{
  "no-new-privileges": true,
  "userns-remap": "default",
  "live-restore": true,
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "5" },
  "default-ulimits": { "nofile": { "Name": "nofile", "Hard": 65536, "Soft": 65536 } },
  "icc": false
}
CONF
systemctl restart docker

echo "── 8. Audit rules ─────────────────────────────────────────────────────────"
cat > /etc/audit/rules.d/qosfc.rules <<'CONF'
-w /etc/docker -p wa -k docker-config
-w /opt/qosfc/deploy/secrets -p rwa -k qosfc-secrets
-w /etc/nftables.conf -p wa -k firewall
-w /etc/ssh/sshd_config.d -p wa -k sshd-config
CONF
augenrules --load 2>/dev/null || true
systemctl enable --now auditd

echo ""
echo "Hardening complete. Verify with: deploy/host/verify-exposure.sh <public-ip>"
echo "⚠ Confirm you can still SSH in — from a SECOND terminal — before closing this one."
