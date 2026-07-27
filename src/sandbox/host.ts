import { spawn } from "child_process";
import { constants } from "fs";
import { mkdir, open, readFile, rename, writeFile } from "fs/promises";
import { dirname, isAbsolute, relative, sep } from "path";
import type { FileHandle } from "fs/promises";
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

  async readFileBase64(path: string): Promise<string> {
    return (await readFile(path)).toString("base64");
  }

  async readFileBase64NoSymlinks(path: string): Promise<string> {
    if (process.platform !== "linux") {
      throw new Error(
        "Attachments are unavailable: this host cannot guarantee symlink-free path traversal",
      );
    }
    if (!isAbsolute(path)) {
      throw new Error("Attachments require an absolute host path");
    }

    const root = path.slice(0, path.startsWith(sep) ? 1 : 0) || sep;
    const relativePath = relative(root, path);
    const parts = relativePath.split(sep).filter((part) => part.length > 0);
    if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
      throw new Error("Attachments require a regular file below the host root");
    }

    const opened: FileHandle[] = [];
    let directory = await open(
      root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    opened.push(directory);
    try {
      for (const [index, part] of parts.entries()) {
        const isFile = index === parts.length - 1;
        const flags = constants.O_RDONLY | constants.O_NOFOLLOW;
        const next = await open(
          `/proc/self/fd/${directory.fd}/${part}`,
          flags | (isFile ? 0 : constants.O_DIRECTORY),
        );
        opened.push(next);
        if (isFile) {
          const stat = await next.stat();
          if (!stat.isFile()) throw new Error("Attachments require a regular file");
          return (await next.readFile()).toString("base64");
        }
        directory = next;
      }
    } finally {
      await Promise.all(opened.toReversed().map((handle) => handle.close()));
    }

    throw new Error("Attachments require a regular file");
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
  credentials: { env: false, fileMounts: false },
  parse: parseHostSandboxArg,
  createExecutor: () => new HostExecutor(),
};
