import { spawn } from "child_process";
import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { dirname } from "path";
import type {
  ExecOptions,
  ExecResult,
  Executor,
  HostSandboxConfig,
  RuntimePathContext,
  SandboxAdapter,
} from "./types.js";
import { killProcessTree } from "./utils.js";
import { createMountedRuntimePathContext } from "./path-context.js";

function parseHostSandboxArg(value: string): HostSandboxConfig | undefined {
  if (value === "host") {
    return { type: "host" };
  }
  return undefined;
}

export class HostExecutor implements Executor {
  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const shell = process.platform === "win32" ? "cmd" : "sh";
      const shellArgs = process.platform === "win32" ? ["/c"] : ["-c"];

      const child = spawn(shell, [...shellArgs, command], {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timeoutHandle =
        options?.timeout && options.timeout > 0
          ? setTimeout(() => {
              timedOut = true;
              killProcessTree(child.pid!);
            }, options.timeout * 1000)
          : undefined;

      const onAbort = () => {
        if (child.pid) killProcessTree(child.pid);
      };

      if (options?.signal) {
        if (options.signal.aborted) {
          onAbort();
        } else {
          options.signal.addEventListener("abort", onAbort, { once: true });
        }
      }

      child.stdout?.on("data", (data) => {
        stdout += data.toString();
        if (stdout.length > 10 * 1024 * 1024) {
          stdout = stdout.slice(0, 10 * 1024 * 1024);
        }
      });

      child.stderr?.on("data", (data) => {
        stderr += data.toString();
        if (stderr.length > 10 * 1024 * 1024) {
          stderr = stderr.slice(0, 10 * 1024 * 1024);
        }
      });

      child.on("close", (code) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (options?.signal) {
          options.signal.removeEventListener("abort", onAbort);
        }

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

export const hostSandboxAdapter: SandboxAdapter<HostSandboxConfig> = {
  type: "host",
  parse: parseHostSandboxArg,
  createExecutor: () => new HostExecutor(),
};
