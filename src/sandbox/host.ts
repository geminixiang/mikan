import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  ExecOptions,
  ExecResult,
  Executor,
  HostSandboxConfig,
  RuntimePathContext,
  SandboxAdapter,
} from "./types.js";
import { createMountedRuntimePathContext, killProcessTree, linkAbortSignal } from "./utils.js";

const MAX_CAPTURE_CHARS = 10 * 1024 * 1024;

interface Capture {
  stdout: string;
  stderr: string;
}

function parseHostSandboxArg(value: string): HostSandboxConfig | undefined {
  if (value === "host") {
    return { type: "host" };
  }
  return undefined;
}

export class HostExecutor implements Executor {
  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const child = spawnShell(command, options?.cwd);
      const capture = captureOutput(child);
      let timedOut = false;

      const timeoutHandle =
        options?.timeout && options.timeout > 0
          ? setTimeout(() => {
              timedOut = true;
              killProcessTree(child.pid!);
            }, options.timeout * 1000)
          : undefined;

      const unlinkSignal = linkAbortSignal(options?.signal, () => {
        if (child.pid) killProcessTree(child.pid);
      });

      child.on("close", (code) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        unlinkSignal();

        const { stdout, stderr } = capture;
        if (options?.signal?.aborted) {
          reject(new Error(`${stdout}\n${stderr}\nCommand aborted`.trim()));
          return;
        }
        if (timedOut) {
          reject(
            new Error(
              `${stdout}\n${stderr}\nCommand timed out after ${options?.timeout} seconds`.trim(),
            ),
          );
          return;
        }
        resolve({ stdout, stderr, code: code ?? 0 });
      });
    });
  }

  async readFile(path: string): Promise<string> {
    return readFile(path, "utf-8");
  }

  async readFileBase64(path: string): Promise<string> {
    return (await readFile(path)).toString("base64");
  }

  async writeFile(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const stage = `${path}.mikan-stage`;
    await writeFile(stage, content, "utf-8");
    await rename(stage, path);
  }

  getWorkspacePath(hostPath: string): string {
    return hostPath;
  }

  getPathContext(hostWorkspaceRoot: string): RuntimePathContext {
    return createMountedRuntimePathContext(hostWorkspaceRoot, hostWorkspaceRoot);
  }

  getSandboxConfig(): HostSandboxConfig {
    return { type: "host" };
  }
}

function spawnShell(command: string, cwd?: string): ChildProcess {
  const isWindows = process.platform === "win32";
  return spawn(isWindows ? "cmd" : "sh", [isWindows ? "/c" : "-c", command], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    cwd: cwd ? cwd : undefined,
  });
}

function captureOutput(child: ChildProcess): Capture {
  const capture: Capture = { stdout: "", stderr: "" };
  for (const stream of ["stdout", "stderr"] as const) {
    child[stream]?.setEncoding("utf8");
    child[stream]?.on("data", (chunk: string) => {
      capture[stream] = (capture[stream] + chunk).slice(0, MAX_CAPTURE_CHARS);
    });
  }
  return capture;
}

export const hostSandboxAdapter: SandboxAdapter<HostSandboxConfig> = {
  type: "host",
  credentials: { env: false, fileMounts: false },
  workspace: { managedProjection: false },
  parse: parseHostSandboxArg,
  createExecutor: () => new HostExecutor(),
};
