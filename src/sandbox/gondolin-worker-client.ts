import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { SandboxError } from "./errors.js";
import { gondolinInventory, type GondolinRuntimeRecord } from "./gondolin-inventory.js";
import type { GondolinWorkerConfig, GondolinWorkerHandshake } from "./gondolin-worker.js";
import type { ExecResult } from "./types.js";

/** A live worker-hosted runtime as seen from mikan. */
export interface GondolinRuntimeHandle {
  sessionId: string;
  socketPath: string;
  workerPid: number;
  fingerprint: string;
}

/**
 * The runtime is gone and the command never reached it (the session socket
 * refused the connection) — safe to recreate the runtime and retry.
 */
export class GondolinRuntimeGoneError extends Error {}

/** The runtime died with the command in flight — not safe to retry blindly. */
export class GondolinRuntimeInterruptedError extends Error {}

interface WorkerProcessLike {
  pid?: number;
  stdout: Readable | null;
  stderr: Readable | null;
  once(event: "close", listener: (code: number | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
  unref(): void;
}

interface SessionClientCallbacks {
  onJson: (message: {
    type: string;
    id?: number;
    exit_code?: number | null;
    code?: string;
    message?: string;
  }) => void;
  onBinary: (frame: Buffer) => void;
  onClose: (error?: Error) => void;
}

interface SessionClient {
  send(message: object): void;
  close(): void;
}

interface GondolinWorkerClientOverrides {
  spawnProcess?: (command: string, args: string[]) => WorkerProcessLike;
  connect?: (socketPath: string, callbacks: SessionClientCallbacks) => SessionClient;
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  handshakeTimeoutMs?: number;
  stopWaitMs?: number;
  stopPollIntervalMs?: number;
}

function defaultSpawnProcess(command: string, args: string[]): WorkerProcessLike {
  return spawn(command, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
}

async function defaultConnect(
  socketPath: string,
  callbacks: SessionClientCallbacks,
): Promise<SessionClient> {
  const { connectToSession } = await import("@earendil-works/gondolin");
  return connectToSession(socketPath, callbacks);
}

function abortError(): Error {
  return new Error("Error: command aborted");
}

class GondolinWorkerClient {
  private spawnProcess = defaultSpawnProcess;
  private connectImpl: (
    socketPath: string,
    callbacks: SessionClientCallbacks,
  ) => SessionClient | Promise<SessionClient> = defaultConnect;
  private killImpl: (pid: number, signal: NodeJS.Signals | 0) => void = (pid, signal) =>
    process.kill(pid, signal);
  private handshakeTimeoutMs = 120_000;
  private stopWaitMs = 15_000;
  private stopPollIntervalMs = 100;

  configure(overrides?: GondolinWorkerClientOverrides): void {
    this.spawnProcess = overrides?.spawnProcess ?? defaultSpawnProcess;
    this.connectImpl = overrides?.connect ?? defaultConnect;
    this.killImpl = overrides?.kill ?? ((pid, signal) => process.kill(pid, signal));
    this.handshakeTimeoutMs = overrides?.handshakeTimeoutMs ?? 120_000;
    this.stopWaitMs = overrides?.stopWaitMs ?? 15_000;
    this.stopPollIntervalMs = overrides?.stopPollIntervalMs ?? 100;
  }

  /** Spawn a detached worker for the config and wait for its ready handshake. */
  async spawn(config: GondolinWorkerConfig): Promise<GondolinRuntimeHandle> {
    const entry = fileURLToPath(new URL("./gondolin-worker-main.js", import.meta.url));
    const child = this.spawnProcess(process.execPath, [entry, JSON.stringify(config)]);
    const handshake = await this.readHandshake(child);
    if (!handshake.ready || !handshake.sessionId || !handshake.socketPath) {
      throw new SandboxError(
        `Error: Gondolin worker failed to start: ${handshake.error ?? "no session in handshake"}`,
      );
    }
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
    return {
      sessionId: handshake.sessionId,
      socketPath: handshake.socketPath,
      workerPid: handshake.workerPid ?? (child.pid as number),
      fingerprint: config.fingerprint,
    };
  }

  /**
   * Adopt a runtime a previous mikan left running: newest live record for the
   * key whose fingerprint still matches and whose session answers a probe.
   * Anything stale — drifted fingerprint, unresponsive session — is stopped so
   * the caller can spawn fresh.
   */
  async adopt(instanceId: string, fingerprint: string): Promise<GondolinRuntimeHandle | undefined> {
    const record: GondolinRuntimeRecord | undefined =
      await gondolinInventory.findAdoptable(instanceId);
    if (!record?.socketPath) return undefined;
    const handle: GondolinRuntimeHandle = {
      sessionId: record.sessionId,
      socketPath: record.socketPath,
      workerPid: record.ownerPid,
      fingerprint: record.fingerprint ?? "",
    };
    if (record.fingerprint !== fingerprint) {
      await this.stop(handle);
      return undefined;
    }
    try {
      await this.exec(handle, "true", { signal: AbortSignal.timeout(5000) });
    } catch {
      await this.stop(handle);
      return undefined;
    }
    return handle;
  }

  /**
   * Stop a worker and wait for it to clean up after itself; escalate to
   * SIGKILL and reap its leftovers if it will not die.
   */
  async stop(handle: Pick<GondolinRuntimeHandle, "workerPid" | "sessionId">): Promise<void> {
    if (this.isPidAlive(handle.workerPid)) {
      this.signal(handle.workerPid, "SIGTERM");
      if (!(await this.waitForExit(handle.workerPid, this.stopWaitMs))) {
        this.signal(handle.workerPid, "SIGKILL");
        await this.waitForExit(handle.workerPid, 2000);
      }
    }
    await gondolinInventory.reapSession(handle.sessionId);
  }

  /** Whether the worker process behind a handle is still alive. */
  isWorkerAlive(handle: Pick<GondolinRuntimeHandle, "workerPid">): boolean {
    return this.isPidAlive(handle.workerPid);
  }

  /**
   * Run one command over a dedicated session IPC connection. Aborting (or the
   * caller's timeout signal firing) destroys the connection, which kills the
   * in-flight guest process.
   */
  async exec(
    handle: GondolinRuntimeHandle,
    command: string,
    options: { env?: Record<string, string>; signal?: AbortSignal } = {},
  ): Promise<ExecResult> {
    if (options.signal?.aborted) throw abortError();
    return await new Promise<ExecResult>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let received = false;
      let settled = false;
      let client: SessionClient | undefined;
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", onAbort);
        fn();
      };
      const onAbort = (): void =>
        settle(() => {
          client?.close();
          reject(abortError());
        });
      const callbacks: SessionClientCallbacks = {
        onJson: (message) => {
          received = true;
          if (message.type === "exec_response" && message.id === 1) {
            settle(() => {
              client?.close();
              resolve({
                stdout,
                stderr,
                code: typeof message.exit_code === "number" ? message.exit_code : 1,
              });
            });
          } else if (message.type === "error") {
            settle(() => {
              client?.close();
              reject(
                new Error(`Error: Gondolin exec failed (${message.code}): ${message.message}`),
              );
            });
          }
        },
        onBinary: (frame) => {
          received = true;
          const tag = frame.readUInt8(0);
          const data = frame.subarray(5).toString("utf8");
          if (tag === 1) stdout += data;
          else stderr += data;
        },
        onClose: (error) => {
          settle(() => {
            const detail = error?.message ?? "connection closed before the command finished";
            const code = (error as NodeJS.ErrnoException | undefined)?.code;
            if (!received && (code === "ENOENT" || code === "ECONNREFUSED")) {
              reject(new GondolinRuntimeGoneError(detail));
            } else {
              reject(new GondolinRuntimeInterruptedError(detail));
            }
          });
        },
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      Promise.resolve(this.connectImpl(handle.socketPath, callbacks))
        .then((created) => {
          client = created;
          if (settled) {
            created.close();
            return;
          }
          created.send({
            type: "exec",
            id: 1,
            cmd: "/bin/sh",
            argv: ["-c", command],
            env: Object.entries(options.env ?? {}).map(([key, value]) => `${key}=${value}`),
            cwd: "/workspace",
          });
        })
        .catch((err: unknown) =>
          settle(() =>
            reject(new GondolinRuntimeGoneError(err instanceof Error ? err.message : String(err))),
          ),
        );
    });
  }

  private signal(pid: number, signal: NodeJS.Signals): void {
    try {
      this.killImpl(pid, signal);
    } catch {
      // already gone
    }
  }

  private isPidAlive(pid: number): boolean {
    try {
      this.killImpl(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private async waitForExit(pid: number, waitMs: number): Promise<boolean> {
    const deadline = Date.now() + waitMs;
    while (this.isPidAlive(pid)) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, this.stopPollIntervalMs));
    }
    return true;
  }

  private readHandshake(child: WorkerProcessLike): Promise<GondolinWorkerHandshake> {
    return new Promise((resolve, reject) => {
      let buffer = "";
      let stderr = "";
      let settled = false;
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        settle(() => {
          child.kill("SIGKILL");
          reject(
            new SandboxError(
              `Error: Gondolin worker did not become ready within ${this.handshakeTimeoutMs}ms${
                stderr ? `: ${stderr.trim()}` : ""
              }`,
            ),
          );
        });
      }, this.handshakeTimeoutMs);
      child.stdout?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        settle(() => {
          try {
            resolve(JSON.parse(line) as GondolinWorkerHandshake);
          } catch {
            child.kill("SIGKILL");
            reject(new SandboxError(`Error: invalid Gondolin worker handshake: ${line}`));
          }
        });
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.once("close", (code) => {
        settle(() =>
          reject(
            new SandboxError(
              `Error: Gondolin worker exited before becoming ready (code ${code})${
                stderr ? `: ${stderr.trim()}` : ""
              }`,
            ),
          ),
        );
      });
      child.once("error", (error) => {
        settle(() =>
          reject(new SandboxError(`Error: failed to spawn Gondolin worker: ${error.message}`)),
        );
      });
    });
  }
}

export const gondolinWorkers = new GondolinWorkerClient();
