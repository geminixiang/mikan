import { spawn } from "child_process";
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

export function parseHostSandboxArg(value: string): HostSandboxConfig | undefined {
  if (value === "host") {
    return { type: "host" };
  }
  return undefined;
}

export async function validateHostSandbox(_config: HostSandboxConfig): Promise<void> {
  return;
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
  validate: validateHostSandbox,
  createExecutor: () => new HostExecutor(),
};
