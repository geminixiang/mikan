#!/usr/bin/env bash
#
# One-command smoke test for gondolin:remote dial-home workers. Drives the real
# code end to end on this machine — auto-inits the gateway, enrolls a worker
# with a one-time token, opens a sandbox, runs a command in the guest, and
# checks that a file written inside the guest lands on the host filesystem.
#
# Requires: a built dist/ (npm run build), the guest image
# (npm run gondolin:image:build), Node >= 23.6, QEMU, and Go (to build the
# worker) or a mikan-worker binary on PATH.
#
# Usage: scripts/smoke-test-remote-worker.sh
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

port="${MIKAN_SMOKE_PORT:-8455}"
work="$(mktemp -d "${TMPDIR:-/tmp}/mikan-smoke.XXXXXX")"
state="$work/state"
workspace="$work/workspace"
creds="$work/worker-creds"
worker_state="$work/worker-state"
mkdir -p "$state" "$workspace/C-smoke" "$creds" "$worker_state"

worker_pid=""
node_pid=""
cleanup() {
  [ -n "$worker_pid" ] && kill "$worker_pid" 2>/dev/null || true
  [ -n "$node_pid" ] && kill "$node_pid" 2>/dev/null || true
  # stop any VM the smoke test left running
  pkill -f "gondolin-worker-main.js" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

info() { printf '\033[1;34m›\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ── preflight ────────────────────────────────────────────────────────────────
[ -f dist/sandbox/gondolin-worker-main.js ] || fail "dist not built — run: npm run build"
command -v node >/dev/null || fail "node not found"
command -v qemu-system-aarch64 >/dev/null || command -v qemu-system-x86_64 >/dev/null || \
  fail "qemu not found"

if command -v mikan-worker >/dev/null; then
  worker_bin="$(command -v mikan-worker)"
  info "using mikan-worker from PATH: $worker_bin"
else
  command -v go >/dev/null || fail "no mikan-worker on PATH and go not found to build one"
  info "building mikan-worker from source"
  worker_bin="$work/mikan-worker"
  (cd worker && go build -o "$worker_bin" ./cmd/mikan-worker)
fi

# ── driver: host gateway + worker + one exec + data round-trip ───────────────
# Runs in Node so it can use the built gateway/fleet/join modules directly, the
# same surfaces mikan itself wires up.
info "starting gateway, enrolling a worker, opening a sandbox…"
MIKAN_SMOKE_PORT="$port" \
MIKAN_SMOKE_STATE="$state" \
MIKAN_SMOKE_WORKSPACE="$workspace" \
MIKAN_SMOKE_CREDS="$creds" \
MIKAN_SMOKE_WORKER_STATE="$worker_state" \
MIKAN_SMOKE_WORKER_BIN="$worker_bin" \
MIKAN_SMOKE_DIST="$repo_root/dist" \
node --input-type=module <<'NODE'
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const env = process.env;
const DIST = env.MIKAN_SMOKE_DIST;
const port = Number(env.MIKAN_SMOKE_PORT);
const workspace = env.MIKAN_SMOKE_WORKSPACE;

const { gondolinFleet } = await import(join(DIST, "sandbox/gondolin-fleet.js"));
const { gondolinGateway } = await import(join(DIST, "sandbox/gondolin-gateway.js"));
const { gondolinJoin } = await import(join(DIST, "sandbox/gondolin-join.js"));
const { gondolinPlacements } = await import(join(DIST, "sandbox/gondolin-placement.js"));

const step = (msg) => console.log(`  ${msg}`);
let worker;

try {
  gondolinPlacements.configure(join(env.MIKAN_SMOKE_STATE, "gondolin-placement.json"));
  gondolinJoin.configure(join(env.MIKAN_SMOKE_STATE, "gondolin-gateway"));
  gondolinFleet.configure({ imageSelector: "mikan-sandbox:latest", queueWaitSeconds: 30 });
  gondolinGateway.configure({ port, hostnames: ["127.0.0.1"], workspaceRoot: workspace });
  await gondolinGateway.start();
  step("gateway listening + CA auto-provisioned");

  const { token, fingerprint } = await gondolinJoin.mintToken();
  await run(env.MIKAN_SMOKE_WORKER_BIN, [
    "join", `https://127.0.0.1:${port}`,
    "--token", token, "--ca-pin", fingerprint, "--name", "smoke-worker",
    "--dir", env.MIKAN_SMOKE_CREDS,
    "--state-dir", env.MIKAN_SMOKE_WORKER_STATE,
    "--worker-entry", join(DIST, "sandbox/gondolin-worker-main.js"),
    "--workspace-root", workspace,
  ]);
  step("worker enrolled (one-time token → CA-signed certificate)");

  worker = spawn(
    env.MIKAN_SMOKE_WORKER_BIN,
    ["connect", "--config", join(env.MIKAN_SMOKE_CREDS, "config.json")],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  await waitFor(() => gondolinGateway.list().some((w) => w.name === "smoke-worker"), 15000,
    "worker never registered with the gateway");
  step("worker connected and registered");

  const handle = await gondolinFleet.ensure("smoke-conversation", {
    image: "mikan-sandbox:latest",
    mounts: [{ source: join(workspace, "C-smoke"), target: "/workspace/C-smoke" }],
    fingerprint: "smoke-fp",
    workspacePath: workspace,
  });
  step(`sandbox opened on worker '${handle.workerName}'`);

  const info = await gondolinFleet.exec(handle, "uname -s && id -un 2>/dev/null || id -u");
  if (info.code !== 0) throw new Error(`exec failed: ${info.stderr}`);
  step(`command ran in guest: ${info.stdout.trim().replace(/\n/g, " / ")}`);

  // data round-trip: write on host → read in guest → write in guest → read on host
  writeFileSync(join(workspace, "C-smoke", "from-host.txt"), "hello from the host\n");
  const seenInGuest = await gondolinFleet.exec(handle, "cat /workspace/C-smoke/from-host.txt");
  if (seenInGuest.stdout.trim() !== "hello from the host") {
    throw new Error("host→guest file not visible in the sandbox");
  }
  await gondolinFleet.exec(handle, "echo 'hello from the guest' > /workspace/C-smoke/from-guest.txt");
  await waitFor(
    () =>
      existsSync(join(workspace, "C-smoke", "from-guest.txt")) &&
      readFileSync(join(workspace, "C-smoke", "from-guest.txt"), "utf8").trim() ===
        "hello from the guest",
    8000,
    "guest→host file never appeared on the shared workspace",
  );
  step("data round-trip verified (host ↔ guest ↔ shared workspace)");

  await gondolinFleet.stop(handle);
  step("sandbox stopped");
  console.log("\n[1;32m✓ gondolin:remote is working on this machine[0m");
} finally {
  worker?.kill("SIGTERM");
  gondolinGateway.stop();
}

function waitFor(check, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      let ok = false;
      try { ok = check(); } catch { ok = false; }
      if (ok) { clearInterval(timer); resolve(); }
      else if (Date.now() > deadline) { clearInterval(timer); reject(new Error(message)); }
    }, 100);
  });
}
NODE
