#!/usr/bin/env bash
#
# Read-only/in-place preflight for the gondolin:remote two-physical-machine
# promotion gate. This script never discovers hosts or deploys software: the
# operator must explicitly name every authorized SSH target.
#
# Usage:
#   MIKAN_GATEWAY_HOST=mikan.internal \
#   MIKAN_WORKSPACE_ROOT=/srv/mikan-workspace \
#   MIKAN_WORKER_WORKSPACE_ROOT=/srv/mikan-workspace \
#   MIKAN_WORKER_ENTRY=/opt/mikan/dist/sandbox/gondolin-worker-main.js \
#   scripts/preflight-gondolin-fleet.sh worker-a worker-b
#
# Optional:
#   MIKAN_GATEWAY_PORT=8433
#   MIKAN_SSH_OPTIONS='-o ProxyJump=bastion'
#   MIKAN_PREFLIGHT_EVIDENCE=/path/to/evidence.log
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "error: pass at least two explicitly authorized SSH worker hosts" >&2
  exit 2
fi

: "${MIKAN_GATEWAY_HOST:?set MIKAN_GATEWAY_HOST to the worker-reachable gateway name or IP}"
: "${MIKAN_WORKSPACE_ROOT:?set MIKAN_WORKSPACE_ROOT to the workspace path on this host}"
: "${MIKAN_WORKER_WORKSPACE_ROOT:?set MIKAN_WORKER_WORKSPACE_ROOT to the shared path on workers}"
: "${MIKAN_WORKER_ENTRY:?set MIKAN_WORKER_ENTRY to gondolin-worker-main.js on workers}"

gateway_port="${MIKAN_GATEWAY_PORT:-8433}"
evidence="${MIKAN_PREFLIGHT_EVIDENCE:-gondolin-fleet-preflight-$(date -u +%Y%m%dT%H%M%SZ).log}"
marker=".mikan-fleet-preflight-$(date +%s)-$$"
local_marker="$MIKAN_WORKSPACE_ROOT/$marker"
worker_markers=()

cleanup() {
  rm -f "$local_marker"
  for path in "${worker_markers[@]}"; do rm -f "$path"; done
}
trap cleanup EXIT

mkdir -p "$MIKAN_WORKSPACE_ROOT"
host_marker_content="host:$(hostname)"
printf '%s\n' "$host_marker_content" >"$local_marker"

# Deliberately split operator-supplied SSH options as shell words. Hosts and
# paths are separately quoted below before crossing the SSH shell boundary.
ssh_options=(
  -o BatchMode=yes
  -o ConnectTimeout=10
  -o ServerAliveInterval=10
  -o ServerAliveCountMax=2
)
if [ -n "${MIKAN_SSH_OPTIONS:-}" ]; then
  read -r -a extra_ssh_options <<<"$MIKAN_SSH_OPTIONS"
  ssh_options+=("${extra_ssh_options[@]}")
fi
remote_script='set -euo pipefail
workspace="$1"
worker_entry="$2"
gateway_host="$3"
gateway_port="$4"
marker="$5"
worker_label="$6"
host_marker_content="$7"

case "$(uname -s)" in
  Linux)
    test -r /dev/kvm && test -w /dev/kvm || { echo "error: /dev/kvm is not usable" >&2; exit 1; }
    machine_id="$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || cat /etc/machine-id)"
    command -v qemu-system-x86_64 >/dev/null
    ;;
  Darwin)
    machine_id="$(sysctl -n kern.boottime | tr -cd "0-9")-$(sysctl -n hw.uuid 2>/dev/null || hostname)"
    command -v qemu-system-aarch64 >/dev/null || command -v qemu-system-x86_64 >/dev/null
    ;;
  *) echo "error: unsupported worker OS" >&2; exit 1 ;;
esac
command -v mikan-worker >/dev/null
command -v node >/dev/null
node -e '\''const [a,b]=process.versions.node.split(".").map(Number);if(a<23||(a===23&&b<6))process.exit(1)'\''
test -f "$worker_entry"
test -d "$workspace"
canonical_workspace="$(cd "$workspace" && pwd -P)"
test "$(cat "$workspace/$marker")" = "$host_marker_content"

probe="$workspace/${marker}.worker-${worker_label}"
elapsed="$(node -e '\''
  const fs = require("fs");
  const [path, content] = process.argv.slice(1);
  const started = performance.now();
  fs.writeFileSync(path, content);
  const fd = fs.openSync(path, "r+");
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  const duration = performance.now() - started;
  if (!Number.isFinite(duration) || duration > 500) process.exit(1);
  process.stdout.write(duration.toFixed(1));
'\'' "$probe" "worker:$worker_label")"

if command -v nc >/dev/null 2>&1; then
  nc -z -w 5 "$gateway_host" "$gateway_port"
elif command -v timeout >/dev/null 2>&1; then
  timeout 5 bash -c "</dev/tcp/$gateway_host/$gateway_port"
else
  echo "error: install nc or timeout for the gateway reachability probe" >&2
  exit 1
fi
printf "RESULT\t%s\t%s\t%s\t%s\t%s\n" "$worker_label" "$machine_id" "$(hostname -f 2>/dev/null || hostname)" "$canonical_workspace" "$elapsed"
'

{
  printf 'gondolin two-machine preflight\n'
  printf 'timestamp_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'gateway=%s:%s\n' "$MIKAN_GATEWAY_HOST" "$gateway_port"
  printf 'host_workspace=%s\n' "$(cd "$MIKAN_WORKSPACE_ROOT" && pwd -P)"
} | tee "$evidence"

machine_ids=()
index=0
for host in "$@"; do
  index=$((index + 1))
  worker_marker="$MIKAN_WORKSPACE_ROOT/${marker}.worker-${index}"
  worker_markers+=("$worker_marker")
  printf 'checking=%s\n' "$host" | tee -a "$evidence"
  printf -v remote_command 'bash -s -- %q %q %q %q %q %q %q' \
    "$MIKAN_WORKER_WORKSPACE_ROOT" "$MIKAN_WORKER_ENTRY" \
    "$MIKAN_GATEWAY_HOST" "$gateway_port" "$marker" "$index" "$host_marker_content"
  result="$(printf '%s' "$remote_script" | ssh "${ssh_options[@]}" "$host" "$remote_command")"
  printf '%s\n' "$result" | tee -a "$evidence"
  result_line="$(printf '%s\n' "$result" | grep '^RESULT' | tail -1)"
  machine_ids+=("$(printf '%s' "$result_line" | cut -f3)")
  test -f "$worker_marker"
  test "$(cat "$worker_marker")" = "worker:$index"
done

unique_ids="$(printf '%s\n' "${machine_ids[@]}" | sort -u | wc -l | tr -d ' ')"
if [ "$unique_ids" -ne "$#" ]; then
  echo "error: SSH targets did not report distinct physical boot identities" | tee -a "$evidence" >&2
  exit 1
fi

printf 'result=PASS workers=%d distinct_machine_ids=%d\n' "$#" "$unique_ids" | tee -a "$evidence"
printf '\n✓ preflight passed; evidence: %s\n' "$evidence"
printf 'Run the documented partition/restart/soak matrix next; this preflight is not that promotion evidence.\n'
