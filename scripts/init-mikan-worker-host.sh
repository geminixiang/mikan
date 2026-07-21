#!/usr/bin/env bash
#
# Provision a Debian/Ubuntu machine to host gondolin:remote workers. Installs
# QEMU/KVM, the guest-image build tools, Node, and the mikan-worker binary,
# then verifies hardware virtualization. Idempotent — safe to re-run.
#
#   curl -fsSL https://raw.githubusercontent.com/geminixiang/mikan/main/scripts/init-mikan-worker-host.sh | sudo -E bash
#
# Environment:
#   MIKAN_WORKER_VERSION   mikan-worker release tag to install (default: latest)
#   NODE_MAJOR             Node major version (default: 24; gondolin needs >=23.6)
set -euo pipefail

node_major="${NODE_MAJOR:-24}"

need_root() {
  if [ "$(id -u)" != "0" ]; then
    echo "error: run as root (sudo)" >&2
    exit 1
  fi
}
say() { printf '\033[1;34m›\033[0m %s\n' "$*"; }

need_root

# ── system packages ──────────────────────────────────────────────────────────
# e2fsprogs (mke2fs) and lz4 are required by the guest-image build; they live in
# /sbin, which non-interactive shells often omit from PATH — handled below.
say "installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
  qemu-system-x86 qemu-utils \
  e2fsprogs lz4 \
  git curl ca-certificates build-essential

# ── Node ─────────────────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 23 ]; then
  say "installing Node ${node_major}"
  curl -fsSL "https://deb.nodesource.com/setup_${node_major}.x" | bash -
  apt-get install -y -qq nodejs
fi
say "node $(node --version)"

# ── /dev/kvm access ──────────────────────────────────────────────────────────
if [ ! -e /dev/kvm ]; then
  echo "WARNING: /dev/kvm is missing — this host has no hardware virtualization." >&2
  echo "         On GCP, create the VM with --enable-nested-virtualization on an" >&2
  echo "         N2/N2D/C2/C3 machine type (E2 does not support it)." >&2
else
  say "/dev/kvm present"
fi
# add the invoking user (not root) to the kvm group for unprivileged access
target_user="${SUDO_USER:-}"
if [ -n "$target_user" ] && ! id -nG "$target_user" | grep -qw kvm; then
  say "adding $target_user to the kvm group (re-login required)"
  usermod -aG kvm "$target_user"
fi

# ── PATH for /sbin tools (persist for the mikan-worker service and shells) ────
if [ ! -f /etc/profile.d/mikan-worker.sh ]; then
  say "adding /usr/sbin:/sbin to PATH (guest-image build needs mke2fs)"
  echo 'export PATH="/usr/sbin:/sbin:$PATH"' > /etc/profile.d/mikan-worker.sh
fi

# ── mikan-worker binary ──────────────────────────────────────────────────────
say "installing mikan-worker"
MIKAN_WORKER_VERSION="${MIKAN_WORKER_VERSION:-latest}" \
  bash -c "curl -fsSL https://raw.githubusercontent.com/geminixiang/mikan/main/scripts/install-mikan-worker.sh | sh"

cat <<'DONE'

✓ worker host provisioned.

Remaining (as the worker user, not root):
  1. Get mikan's dist + guest image on this machine:
       git clone --depth 1 https://github.com/geminixiang/mikan.git
       cd mikan && npm ci && npm run build
       PATH="/usr/sbin:/sbin:$PATH" npm run gondolin:image:build
  2. Enrol against your mikan host (mint a token there with `mikan --worker-token`):
       mikan-worker join https://<host>:<port> --token <t> --ca-pin sha256:<hex> \
         --name <this-worker> --dir ~/mikan-worker \
         --workspace-root ~/mikan-workspace \
         --worker-entry "$(pwd)/mikan/dist/sandbox/gondolin-worker-main.js"
       mkdir -p ~/mikan-workspace
  3. Install and start the persistent worker service:
       sudo mikan-worker install-service --config ~/mikan-worker/config.json
DONE
