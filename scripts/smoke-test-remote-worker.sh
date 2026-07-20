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
soak_cycles="${MIKAN_SMOKE_SOAK_CYCLES:-0}"
work="$(mktemp -d "${TMPDIR:-/tmp}/mikan-smoke.XXXXXX")"
state="$work/state"
workspace="$work/workspace"
creds="$work/worker-creds"
creds2="$work/worker-creds-2"
rotated_creds="$work/worker-creds-rotated"
worker_state="$work/worker-state"
worker_state2="$work/worker-state-2"
smoke_secret="$work/smoke-secret"
mkdir -p "$state" "$workspace/C-smoke" "$creds" "$creds2" "$rotated_creds" "$worker_state" "$worker_state2"
printf 'secret-v1\n' >"$smoke_secret"
chmod 600 "$smoke_secret"

worker_pid=""
worker2_pid=""
node_pid=""
cleanup() {
  [ -n "$worker_pid" ] && kill "$worker_pid" 2>/dev/null || true
  [ -n "$worker2_pid" ] && kill "$worker2_pid" 2>/dev/null || true
  [ -n "$node_pid" ] && kill "$node_pid" 2>/dev/null || true
  # stop any VM the smoke test left running
  pkill -f "gondolin-worker-main.js" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

info() { printf '\033[1;34m›\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

case "$soak_cycles" in
  ''|*[!0-9]*) fail "MIKAN_SMOKE_SOAK_CYCLES must be a non-negative integer" ;;
esac

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
MIKAN_SMOKE_SOAK_CYCLES="$soak_cycles" \
MIKAN_SMOKE_STATE="$state" \
MIKAN_SMOKE_WORKSPACE="$workspace" \
MIKAN_SMOKE_CREDS="$creds" \
MIKAN_SMOKE_CREDS_2="$creds2" \
MIKAN_SMOKE_ROTATED_CREDS="$rotated_creds" \
MIKAN_SMOKE_WORKER_STATE="$worker_state" \
MIKAN_SMOKE_WORKER_STATE_2="$worker_state2" \
MIKAN_SMOKE_SECRET="$smoke_secret" \
MIKAN_SMOKE_WORKER_BIN="$worker_bin" \
MIKAN_SMOKE_DIST="$repo_root/dist" \
node --input-type=module <<'NODE'
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const env = process.env;
const DIST = env.MIKAN_SMOKE_DIST;
const port = Number(env.MIKAN_SMOKE_PORT);
const workspace = env.MIKAN_SMOKE_WORKSPACE;
const soakCycles = Number(env.MIKAN_SMOKE_SOAK_CYCLES);
const runtimeMounts = () => [
  { source: join(workspace, "C-smoke"), target: "/workspace/C-smoke" },
  { source: env.MIKAN_SMOKE_SECRET, target: "/root/.smoke-secret" },
];

const { gondolinFleet } = await import(join(DIST, "sandbox/gondolin-fleet.js"));
const { gondolinGateway } = await import(join(DIST, "sandbox/gondolin-gateway.js"));
const { gondolinJoin } = await import(join(DIST, "sandbox/gondolin-join.js"));
const { configureGondolinNetworkPolicy } = await import(join(DIST, "sandbox/gondolin.js"));
const { gondolinPlacements } = await import(join(DIST, "sandbox/gondolin-placement.js"));

const step = (msg) => console.log(`  ${msg}`);
let worker;
let worker2;
let staleWorker;

try {
  gondolinPlacements.configure(join(env.MIKAN_SMOKE_STATE, "gondolin-placement.json"));
  configureGondolinNetworkPolicy({ blockInternalRanges: true });
  gondolinJoin.configure(join(env.MIKAN_SMOKE_STATE, "gondolin-gateway"));
  gondolinFleet.configure(
    { imageSelector: "mikan-sandbox:latest", queueWaitSeconds: 30 },
    { connectionOverrides: { leaseTtlSeconds: 6 } },
  );
  gondolinGateway.configure(
    { port, hostnames: ["127.0.0.1"], workspaceRoot: workspace },
    { leaseTtlSeconds: 6 },
  );
  await gondolinGateway.start();
  step("gateway listening + CA auto-provisioned");

  const firstJoin = await gondolinJoin.mintToken();
  await run(env.MIKAN_SMOKE_WORKER_BIN, [
    "join", `https://127.0.0.1:${port}`,
    "--token", firstJoin.token, "--ca-pin", firstJoin.fingerprint, "--name", "smoke-worker",
    "--dir", env.MIKAN_SMOKE_CREDS,
    "--state-dir", env.MIKAN_SMOKE_WORKER_STATE,
    "--worker-entry", join(DIST, "sandbox/gondolin-worker-main.js"),
    "--workspace-root", workspace,
  ]);
  const secondJoin = await gondolinJoin.mintToken();
  await run(env.MIKAN_SMOKE_WORKER_BIN, [
    "join", `https://127.0.0.1:${port}`,
    "--token", secondJoin.token, "--ca-pin", secondJoin.fingerprint, "--name", "smoke-worker-2",
    "--dir", env.MIKAN_SMOKE_CREDS_2,
    "--state-dir", env.MIKAN_SMOKE_WORKER_STATE_2,
    "--worker-entry", join(DIST, "sandbox/gondolin-worker-main.js"),
    "--workspace-root", workspace,
  ]);
  step("two workers enrolled (one-time tokens → identity-bound certificates)");

  const startWorker = (credentialsDir) =>
    spawn(
      env.MIKAN_SMOKE_WORKER_BIN,
      ["connect", "--config", join(credentialsDir, "config.json")],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
  worker = startWorker(env.MIKAN_SMOKE_CREDS);
  worker2 = startWorker(env.MIKAN_SMOKE_CREDS_2);
  await waitFor(() => gondolinGateway.list().length === 2, 15000,
    "workers never registered with the gateway");
  step("two workers connected and registered");

  let handle = await gondolinFleet.ensure("smoke-conversation", {
    image: "mikan-sandbox:latest",
    mounts: runtimeMounts(),
    fingerprint: "smoke-fp",
    workspacePath: workspace,
  });
  step(`sandbox opened on worker '${handle.workerName}'`);
  const placedWorkerName = handle.workerName;
  const standbyWorkerName = placedWorkerName === "smoke-worker" ? "smoke-worker-2" : "smoke-worker";
  const stopPlacedWorker = () => {
    if (placedWorkerName === "smoke-worker") worker.kill("SIGTERM");
    else worker2.kill("SIGTERM");
  };
  let placedCredentials = placedWorkerName === "smoke-worker"
    ? env.MIKAN_SMOKE_CREDS
    : env.MIKAN_SMOKE_CREDS_2;
  const restartPlacedWorker = () => {
    if (placedWorkerName === "smoke-worker") worker = startWorker(placedCredentials);
    else worker2 = startWorker(placedCredentials);
  };
  const rotatePlacedWorkerCertificate = async () => {
    const replacementJoin = await gondolinJoin.mintToken(placedWorkerName);
    await run(env.MIKAN_SMOKE_WORKER_BIN, [
      "join", `https://127.0.0.1:${port}`,
      "--token", replacementJoin.token, "--ca-pin", replacementJoin.fingerprint,
      "--name", placedWorkerName,
      "--dir", env.MIKAN_SMOKE_ROTATED_CREDS,
      "--state-dir", placedWorkerName === "smoke-worker"
        ? env.MIKAN_SMOKE_WORKER_STATE
        : env.MIKAN_SMOKE_WORKER_STATE_2,
      "--worker-entry", join(DIST, "sandbox/gondolin-worker-main.js"),
      "--workspace-root", workspace,
    ]);
    const staleCredentials = placedCredentials;
    placedCredentials = env.MIKAN_SMOKE_ROTATED_CREDS;
    return staleCredentials;
  };

  const info = await gondolinFleet.exec(handle, "uname -s && id -un 2>/dev/null || id -u");
  if (info.code !== 0) throw new Error(`exec failed: ${info.stderr}`);
  step(`command ran in guest: ${info.stdout.trim().replace(/\n/g, " / ")}`);

  const metadataProbe = await gondolinFleet.exec(
    handle,
    "command -v curl >/dev/null || exit 125; curl --connect-timeout 2 --max-time 3 -fsS http://169.254.169.254/latest/meta-data/ >/dev/null",
  );
  if (metadataProbe.code === 125) {
    throw new Error("guest image lacks curl; secure egress probe did not run");
  }
  if (metadataProbe.code === 0) {
    throw new Error("guest reached the cloud metadata address despite secure egress policy");
  }
  step("explicit secure egress policy blocked the cloud metadata address");

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

  const initialCredential = await gondolinFleet.exec(handle, "cat /root/.smoke-secret");
  if (initialCredential.stdout.trim() !== "secret-v1") {
    throw new Error("initial credential projection was not visible in the guest");
  }
  writeFileSync(env.MIKAN_SMOKE_SECRET, "secret-v2\n", { mode: 0o600 });
  const credentialRotated = await gondolinFleet.ensure("smoke-conversation", {
    image: "mikan-sandbox:latest",
    mounts: runtimeMounts(),
    fingerprint: "smoke-fp",
    workspacePath: workspace,
  });
  if (credentialRotated.sessionId === handle.sessionId) {
    throw new Error("credential content changed without recreating the runtime");
  }
  const rotatedCredential = await gondolinFleet.exec(
    credentialRotated,
    "cat /root/.smoke-secret",
  );
  if (rotatedCredential.stdout.trim() !== "secret-v2") {
    throw new Error("rotated credential projection was stale in the replacement runtime");
  }
  handle = credentialRotated;
  step("credential content rotation created an immutable generation and replacement runtime");

  // resilience round-trip: the daemon may restart while its detached runtime
  // survives. The gateway must detach promptly and accept the same authenticated
  // worker identity again. Acquiring the post-restart epoch must fence and
  // recreate the old runtime because socket EOF cannot cancel a command already
  // admitted to Gondolin's guest control plane.
  stopPlacedWorker();
  await waitFor(() => !gondolinGateway.list().some((w) => w.name === placedWorkerName), 5000,
    "gateway did not detect the worker disconnect");
  step("worker daemon stopped; gateway detected the disconnect");

  const staleCredentials = await rotatePlacedWorkerCertificate();
  restartPlacedWorker();
  await waitFor(() => gondolinGateway.list().some((w) => w.name === placedWorkerName), 15000,
    "worker did not reconnect after certificate rotation");
  const recreated = await gondolinFleet.ensure("smoke-conversation", {
    image: "mikan-sandbox:latest",
    mounts: runtimeMounts(),
    fingerprint: "smoke-fp",
    workspacePath: workspace,
  });
  if (recreated.sessionId === handle.sessionId) {
    throw new Error("replacement lease adopted an old-epoch runtime instead of fencing it");
  }
  const afterRestart = await gondolinFleet.exec(recreated, "cat /workspace/C-smoke/from-guest.txt");
  if (afterRestart.stdout.trim() !== "hello from the guest") {
    throw new Error("recreated runtime lost shared workspace state after worker restart");
  }
  step("worker re-enrolled, rotated its certificate, fenced the old epoch, and recreated the runtime");

  const connectedAt = gondolinGateway.list().find((w) => w.name === placedWorkerName)?.connectedAt;
  staleWorker = startWorker(staleCredentials);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const afterReplay = gondolinGateway.list().find((w) => w.name === placedWorkerName);
  if (!afterReplay || afterReplay.connectedAt !== connectedAt) {
    throw new Error("superseded certificate reclaimed the rotated worker identity");
  }
  staleWorker.kill("SIGTERM");
  staleWorker = undefined;
  step("superseded certificate could not reclaim the rotated worker identity");

  // Gateway restart is a separate failure domain. Start a command that would
  // write after the disconnect: transport EOF alone cannot cancel it inside
  // Gondolin. Reconnect must acquire a new epoch, stop the old VM before the
  // grant is returned, and create a replacement without allowing that stale
  // command to publish.
  const staleMarker = join(workspace, "C-smoke", "stale-after-gateway-restart.txt");
  const staleCommand = gondolinFleet
    .exec(recreated, "sleep 8; echo stale > /workspace/C-smoke/stale-after-gateway-restart.txt")
    .then(
      () => {
        throw new Error("old-epoch command unexpectedly completed after gateway restart");
      },
      () => undefined,
    );
  await new Promise((resolve) => setTimeout(resolve, 500));
  gondolinGateway.stop();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await gondolinGateway.start();
  await waitFor(() => gondolinGateway.list().length === 2, 15000,
    "workers did not reconnect after gateway restart");
  const afterGatewayRestart = await gondolinFleet.ensure("smoke-conversation", {
    image: "mikan-sandbox:latest",
    mounts: runtimeMounts(),
    fingerprint: "smoke-fp",
    workspacePath: workspace,
  });
  if (afterGatewayRestart.sessionId === recreated.sessionId) {
    throw new Error("gateway restart adopted an old-epoch runtime instead of fencing it");
  }
  await staleCommand;
  await new Promise((resolve) => setTimeout(resolve, 8000));
  if (existsSync(staleMarker)) {
    throw new Error("old-epoch command wrote to the workspace after replacement grant");
  }
  const finalCheck = await gondolinFleet.exec(afterGatewayRestart, "printf gateway-ok");
  if (finalCheck.stdout !== "gateway-ok") throw new Error("exec failed after gateway restart");
  step("gateway restarted; old-epoch command was fenced before runtime replacement");

  // Fenced failover: killing the placed daemon must not move the conversation
  // immediately. Its detached VM gets a 30s heartbeat watchdog plus a bounded
  // hard-close path; the host opens the placement fence only after lease TTL +
  // grace (51s in this smoke).
  stopPlacedWorker();
  await waitFor(() => !gondolinGateway.list().some((w) => w.name === placedWorkerName), 5000,
    "gateway did not detect the placed worker failure");
  await expectReject(
    () => gondolinFleet.ensure("smoke-conversation", {
      image: "mikan-sandbox:latest",
      mounts: runtimeMounts(),
      fingerprint: "smoke-fp",
      workspacePath: workspace,
    }),
    "lease fence has passed",
  );
  step("failover correctly blocked while the old runtime could still be alive");

  await new Promise((resolve) => setTimeout(resolve, 52000));
  await waitFor(() => !pidAlive(afterGatewayRestart.workerPid), 5000,
    "old detached runtime survived beyond the fencing watchdog");
  step("old detached runtime stopped before the placement fence opened");
  const failedOver = await gondolinFleet.ensure("smoke-conversation", {
    image: "mikan-sandbox:latest",
    mounts: runtimeMounts(),
    fingerprint: "smoke-fp",
    workspacePath: workspace,
  });
  if (failedOver.workerName !== standbyWorkerName) {
    throw new Error(`fenced failover selected ${failedOver.workerName}, expected ${standbyWorkerName}`);
  }
  const failoverCheck = await gondolinFleet.exec(failedOver, "cat /workspace/C-smoke/from-guest.txt");
  if (failoverCheck.stdout.trim() !== "hello from the guest") {
    throw new Error("failed-over runtime lost shared workspace access");
  }
  step("lease fence passed; conversation failed over to worker 2 with workspace intact");

  await gondolinFleet.stop(failedOver);
  step("sandbox stopped");

  if (soakCycles > 0) {
    restartPlacedWorker();
    await waitFor(() => gondolinGateway.list().length === 2, 15000,
      "placed worker did not reconnect for soak cycles");
    for (let cycle = 1; cycle <= soakCycles; cycle += 1) {
      const ids = [`soak-${cycle}-a`, `soak-${cycle}-b`];
      for (const id of ids) mkdirSync(join(workspace, id), { recursive: true });
      const handles = await Promise.all(
        ids.map((id) => gondolinFleet.ensure(id, {
          image: "mikan-sandbox:latest",
          mounts: [{ source: join(workspace, id), target: `/workspace/${id}` }],
          fingerprint: `soak-fp-${cycle}`,
          workspacePath: workspace,
        })),
      );
      if (new Set(handles.map((handle) => handle.workerName)).size !== 2) {
        throw new Error(`soak cycle ${cycle} did not distribute concurrent placements`);
      }
      await Promise.all(
        handles.map(async (handle, index) => {
          const id = ids[index];
          const marker = `cycle-${cycle}-${index}`;
          const result = await gondolinFleet.exec(
            handle,
            `printf %s '${marker}' > '/workspace/${id}/marker' && cat '/workspace/${id}/marker'`,
          );
          if (result.stdout !== marker) throw new Error(`soak cycle ${cycle} exec mismatch`);
          if (readFileSync(join(workspace, id, "marker"), "utf8") !== marker) {
            throw new Error(`soak cycle ${cycle} workspace mismatch`);
          }
        }),
      );
      await Promise.all(handles.map((handle) => gondolinFleet.stop(handle)));
      step(`soak cycle ${cycle}/${soakCycles}: concurrent create/exec/stop passed`);
    }
  }

  console.log("\n\u001b[1;32m✓ gondolin:remote is working on this machine\u001b[0m");
} finally {
  staleWorker?.kill("SIGTERM");
  worker?.kill("SIGTERM");
  worker2?.kill("SIGTERM");
  gondolinGateway.stop();
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function expectReject(operation, message) {
  try {
    await operation();
  } catch (error) {
    if (error instanceof Error && error.message.includes(message)) return;
    throw error;
  }
  throw new Error(`expected rejection containing: ${message}`);
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
