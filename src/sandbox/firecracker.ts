import { spawn } from "child_process";
import type {
  ExecOptions,
  ExecResult,
  Executor,
  FirecrackerSandboxConfig,
  RuntimePathContext,
  SandboxAdapter,
  SandboxSecrets,
} from "./types.js";
import { SandboxError } from "./errors.js";
import { HostExecutor } from "./host.js";
import { execSimple, killProcessTree, shellEscape } from "./utils.js";

function parseFirecrackerSandboxArg(value: string): FirecrackerSandboxConfig | undefined {
  if (!value.startsWith("firecracker:")) {
    return undefined;
  }

  const arg = value.slice("firecracker:".length);
  // Format: firecracker:<vm-id>:<host-path>[:<ssh-user>[:<ssh-port>]]
  // Example: firecracker:vm1:/home/user/workspace
  //          firecracker:vm1:/home/user/workspace:root
  //          firecracker:vm1:/home/user/workspace:root:22
  const parts = arg.split(":");
  if (parts.length < 2) {
    throw new SandboxError(
      "Error: firecracker sandbox requires vm-id and host-path\n" +
        "Usage: firecracker:<vm-id>:<host-path>[:<ssh-user>[:<ssh-port>]]\n" +
        "Example: firecracker:vm1:/home/user/workspace",
    );
  }
  const vmId = parts[0];
  const hostPath = parts[1];
  const sshUser = parts[2] || "root";
  const sshPort = parts[3] ? parseInt(parts[3], 10) : 22;

  if (!vmId || !hostPath) {
    throw new SandboxError("Error: firecracker sandbox requires vm-id and host-path");
  }
  if (isNaN(sshPort) || sshPort <= 0 || sshPort > 65535) {
    throw new SandboxError("Error: invalid SSH port");
  }
  return { type: "firecracker", vmId, hostPath, sshUser, sshPort };
}

async function validateFirecrackerSandbox(config: FirecrackerSandboxConfig): Promise<void> {
  // Check if fc-agent or firecracker CLI is available
  try {
    await execSimple("fc-agent", ["--version"]);
  } catch {
    // Try alternative: firecracker
    try {
      await execSimple("firecracker", ["--version"]);
    } catch {
      throw new SandboxError(
        "Error: Firecracker tools (fc-agent or firecracker) not found in PATH",
        ["Install firecracker: https://github.com/firecracker-microvm/firecracker"],
      );
    }
  }

  // Check if VM is running using fc-agent
  try {
    const result = await execSimple("fc-agent", ["status", config.vmId]);
    if (!result.includes("running") && !result.includes("Running")) {
      throw new SandboxError(`Error: Firecracker VM '${config.vmId}' is not running.`, [
        `Start it with: fc-agent start ${config.vmId}`,
      ]);
    }
  } catch (error) {
    if (error instanceof SandboxError) {
      throw error;
    }
    // Try alternative: firecracker-ctl or direct check
    try {
      await execSimple("firecracker-ctl", ["status", config.vmId]);
    } catch {
      console.error(`Warning: Could not verify if VM '${config.vmId}' is running.`);
      console.error("Make sure the VM is started before running mikan.");
    }
  }

  // Verify host path exists
  try {
    await execSimple("ls", ["-d", config.hostPath]);
  } catch {
    throw new SandboxError(`Error: Host path '${config.hostPath}' does not exist.`);
  }

  console.log(`  Firecracker VM '${config.vmId}' configured with workspace '${config.hostPath}'.`);
}

export class FirecrackerExecutor implements Executor {
  constructor(
    private vmId: string,
    private hostPath: string,
    private sshUser: string = "root",
    private sshPort: number = 22,
    private secrets?: SandboxSecrets,
  ) {}

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    const env = this.secrets?.env;
    if (!env || Object.keys(env).length === 0) {
      const sshCmd =
        this.sshPort === 22
          ? `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${this.sshUser}@${this.vmId} sh -c ${shellEscape(command)}`
          : `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${this.sshPort} ${this.sshUser}@${this.vmId} sh -c ${shellEscape(command)}`;
      const hostExecutor = new HostExecutor();
      return hostExecutor.exec(sshCmd, options);
    }

    return new Promise((resolve, reject) => {
      const sshArgs = ["-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=10"];
      if (this.sshPort !== 22) {
        sshArgs.push("-p", String(this.sshPort));
      }
      sshArgs.push(`${this.sshUser}@${this.vmId}`, "sh", "-se");

      const child = spawn("ssh", sshArgs, {
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      const timeoutHandle =
        options?.timeout && options.timeout > 0
          ? setTimeout(() => {
              timedOut = true;
              if (child.pid) killProcessTree(child.pid);
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

      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (options?.signal) {
          options.signal.removeEventListener("abort", onAbort);
        }
        reject(error);
      });

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

      child.stdin?.on("error", (error) => {
        stderr += `${error.message}\n`;
      });
      child.stdin?.end(buildRemoteScript(command, env));

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
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

  getWorkspacePath(_hostPath: string): string {
    return "/workspace";
  }

  getPathContext(hostWorkspaceRoot: string): RuntimePathContext {
    return {
      hostWorkspaceRoot,
      runtimeWorkspaceRoot: "/workspace",
    };
  }

  getSandboxConfig(): FirecrackerSandboxConfig {
    return {
      type: "firecracker",
      vmId: this.vmId,
      hostPath: this.hostPath,
      sshUser: this.sshUser,
      sshPort: this.sshPort,
    };
  }
}

function buildRemoteScript(command: string, env?: Record<string, string>): string {
  const exports = env
    ? Object.entries(env)
        .map(([key, value]) => {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
            throw new SandboxError(`Invalid environment variable name for firecracker: ${key}`);
          }
          return `export ${key}=${shellEscape(value)}`;
        })
        .join("\n") + "\n"
    : "";
  return `${exports}${command}\n`;
}

export const firecrackerSandboxAdapter: SandboxAdapter<FirecrackerSandboxConfig> = {
  type: "firecracker",
  parse: parseFirecrackerSandboxArg,
  validate: validateFirecrackerSandbox,
  createExecutor: (config, secrets) =>
    new FirecrackerExecutor(config.vmId, config.hostPath, config.sshUser, config.sshPort, secrets),
};
