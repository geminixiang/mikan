import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { hostname, platform } from "node:os";
import { join } from "node:path";
import { atomicWritePrivateFile } from "../utils/fs-atomic.js";

interface CoordinatorOwner {
  pid: number;
  machine: string;
  nonce: string;
  startedAt: string;
}

interface MachineIdentity {
  value: string;
  recoverable: boolean;
}

function machineIdentity(): MachineIdentity {
  try {
    if (platform() === "linux") {
      const machine = readFileSync("/etc/machine-id", "utf8").trim();
      const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      if (machine && boot) return { value: `linux:${machine}:${boot}`, recoverable: true };
    } else if (platform() === "darwin") {
      const machine = execFileSync("sysctl", ["-n", "kern.uuid"], {
        encoding: "utf8",
        timeout: 2000,
      }).trim();
      const boot = execFileSync("sysctl", ["-n", "kern.boottime"], {
        encoding: "utf8",
        timeout: 2000,
      }).trim();
      if (machine && boot) return { value: `darwin:${machine}:${boot}`, recoverable: true };
    }
  } catch {
    // Fall through to an intentionally non-recoverable process identity.
  }
  return {
    value: `unverified:${hostname()}:${process.pid}:${randomUUID()}`,
    recoverable: false,
  };
}

function ownerPath(directory: string): string {
  return join(directory, "owner.json");
}

function readOwner(directory: string): CoordinatorOwner {
  const parsed: unknown = JSON.parse(readFileSync(ownerPath(directory), "utf8"));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("pid" in parsed) ||
    !Number.isSafeInteger(parsed.pid) ||
    (parsed.pid as number) <= 0 ||
    !("machine" in parsed) ||
    typeof parsed.machine !== "string" ||
    !parsed.machine ||
    !("nonce" in parsed) ||
    typeof parsed.nonce !== "string" ||
    !parsed.nonce ||
    !("startedAt" in parsed) ||
    typeof parsed.startedAt !== "string" ||
    !Number.isFinite(Date.parse(parsed.startedAt))
  ) {
    throw new Error("invalid coordinator owner record");
  }
  return parsed as unknown as CoordinatorOwner;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

/**
 * Exclusively claims one host-side Gondolin state directory. This protects the
 * file-backed placement/identity authority from two local mikan coordinators.
 * A lock from another machine is never broken automatically: PID liveness is
 * only meaningful in the local PID namespace.
 */
export function acquireGondolinCoordinatorLock(stateDir: string): () => void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const lockDir = join(stateDir, "gondolin-coordinator.lock");
  const identity = machineIdentity();
  const machine = identity.value;
  const owner: CoordinatorOwner = {
    pid: process.pid,
    machine,
    nonce: randomUUID(),
    startedAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const staged = `${lockDir}.${process.pid}.${owner.nonce}.tmp`;
    mkdirSync(staged, { mode: 0o700 });
    atomicWritePrivateFile(ownerPath(staged), `${JSON.stringify(owner, null, 2)}\n`);
    try {
      renameSync(staged, lockDir);
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        process.removeListener("exit", release);
        try {
          if (readOwner(lockDir).nonce === owner.nonce) rmSync(lockDir, { recursive: true });
        } catch {
          // Never remove a lock whose ownership can no longer be proven.
        }
      };
      process.once("exit", release);
      return release;
    } catch (claimError) {
      rmSync(staged, { recursive: true, force: true });
      if (!existsSync(lockDir)) {
        if (attempt === 0) continue;
        throw claimError;
      }
      let current: CoordinatorOwner;
      try {
        current = readOwner(lockDir);
      } catch (error) {
        throw new Error(
          `Gondolin coordinator lock at ${lockDir} is unreadable; refusing to reset placement authority`,
          { cause: error },
        );
      }
      if (current.machine !== machine || !identity.recoverable) {
        throw new Error(
          `Gondolin state directory is owned by coordinator ${current.pid} on '${current.machine}'; cross-host lock recovery requires operator intervention`,
          { cause: claimError },
        );
      }
      if (processAlive(current.pid)) {
        throw new Error(
          `Gondolin state directory is already owned by coordinator process ${current.pid}`,
          { cause: claimError },
        );
      }
      const stale = `${lockDir}.${process.pid}.${randomUUID()}.stale`;
      try {
        renameSync(lockDir, stale);
      } catch (error) {
        if (attempt === 0) continue;
        throw new Error(`Unable to quarantine stale Gondolin coordinator lock ${lockDir}`, {
          cause: error,
        });
      }
      rmSync(stale, { recursive: true, force: true });
    }
  }
  throw new Error(`Unable to claim Gondolin coordinator state directory ${stateDir}`);
}
