import type {
  ContainerSandboxConfig,
  ExecOptions,
  ExecResult,
  Executor,
  RuntimePathContext,
  SandboxAdapter,
} from "./types.js";
import { SandboxError } from "./errors.js";
import { resolveCommandEnv } from "./credential-policy.js";
import { execSimple, shellEscape } from "./utils.js";
import { HostExecutor } from "./host.js";
import { createMountedRuntimePathContext } from "./path-context.js";

function parseContainerSandboxArg(value: string): ContainerSandboxConfig | undefined {
  if (!value.startsWith("container:")) {
    return undefined;
  }

  const container = value.slice("container:".length);
  if (!container) {
    throw new SandboxError(
      "Error: container sandbox requires container name (e.g., container:mikan-sandbox)",
    );
  }
  return { type: "container", container };
}

async function validateContainerSandbox(config: ContainerSandboxConfig): Promise<void> {
  try {
    await execSimple("docker", ["--version"]);
  } catch {
    throw new SandboxError("Error: Docker is not installed or not in PATH");
  }

  try {
    const result = await execSimple("docker", [
      "inspect",
      "-f",
      "{{.State.Running}}",
      config.container,
    ]);
    if (result.trim() !== "true") {
      throw new SandboxError(`Error: Container '${config.container}' is not running.`, [
        `Start it with: docker start ${config.container}`,
      ]);
    }
  } catch (error) {
    if (error instanceof SandboxError) {
      throw error;
    }
    throw new SandboxError(`Error: Container '${config.container}' does not exist.`, [
      `Create it with: docker run -d --name ${config.container} -v <workspace>:/workspace alpine:latest sleep infinity`,
    ]);
  }

  console.log(`  Container '${config.container}' is running.`);
}

function buildContainerExecCommand(
  container: string,
  command: string,
  env?: Record<string, string>,
): string {
  const commandEnv = resolveCommandEnv(command, env);
  const envPart = commandEnv
    ? Object.entries(commandEnv)
        .map(([key, value]) => `-e ${shellEscape(`${key}=${value}`)} `)
        .join("")
    : "";
  return `docker exec ${envPart}-w /workspace ${container} sh -c ${shellEscape(command)}`;
}

export class ContainerExecutor implements Executor {
  constructor(
    private container: string,
    private env?: Record<string, string>,
    private ensureReady?: () => Promise<void>,
  ) {}

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    if (this.ensureReady) {
      await this.ensureReady();
    } else {
      await ensureContainerRunning(this.container);
    }

    const hostExecutor = new HostExecutor();
    const dockerCmd = buildContainerExecCommand(this.container, command, this.env);
    return await hostExecutor.exec(dockerCmd, options);
  }

  getWorkspacePath(_hostPath: string): string {
    return "/workspace";
  }

  getPathContext(hostWorkspaceRoot: string): RuntimePathContext {
    return createMountedRuntimePathContext(hostWorkspaceRoot, "/workspace");
  }

  getSandboxConfig(): ContainerSandboxConfig {
    return { type: "container", container: this.container };
  }
}

export const containerSandboxAdapter: SandboxAdapter<ContainerSandboxConfig> = {
  type: "container",
  parse: parseContainerSandboxArg,
  validate: validateContainerSandbox,
  createExecutor: (config, env, ensureReady) =>
    new ContainerExecutor(config.container, env, ensureReady),
};

async function ensureContainerRunning(container: string): Promise<void> {
  try {
    const running = await execSimple("docker", ["inspect", "-f", "{{.State.Running}}", container]);
    if (running.trim() === "true") {
      return;
    }
    await execSimple("docker", ["start", container]);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Container "${container}" is not available. ` +
        `Expected a pre-existing container or image provisioning to keep it running.\n${details}`.trim(),
      { cause: error },
    );
  }
}
