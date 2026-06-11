import type {
  ContainerSandboxConfig,
  ExecOptions,
  ExecResult,
  RuntimePathContext,
} from "../../types.js";
import type { SandboxInstance, SandboxProvider } from "../../spi.js";
import { SandboxError } from "../../errors.js";
import { execSimple, shellEscape } from "../../utils.js";
import { HostExecutor } from "../host.js";
import { createMountedRuntimePathContext } from "../../path-context.js";

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
  // Secrets are handed to `docker exec` through the docker CLI's own process
  // env (`-e KEY` without a value reads from it), so they never touch disk or
  // the command line.
  const envPart = envFlagKeys(env)
    .map((key) => `-e ${key} `)
    .join("");
  return `docker exec ${envPart}-w /workspace ${container} sh -c ${shellEscape(command)}`;
}

function envFlagKeys(env?: Record<string, string>): string[] {
  if (!env) return [];
  const keys = Object.keys(env).toSorted();
  for (const key of keys) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new SandboxError(`Invalid environment variable name for docker exec: ${key}`);
    }
  }
  return keys;
}

function withRuntimeBootstrap(command: string, env?: Record<string, string>): string {
  if (!hasGitHubToken(env)) {
    return command;
  }

  return [
    "if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then gh auth setup-git >/dev/null 2>&1 || true; fi",
    command,
  ].join("\n");
}

function hasGitHubToken(env?: Record<string, string>): boolean {
  return Boolean(env?.GH_TOKEN || env?.GITHUB_TOKEN || env?.GITHUB_OAUTH_ACCESS_TOKEN);
}

export class ContainerExecutor implements SandboxInstance {
  constructor(
    private container: string,
    private env?: Record<string, string>,
    private ensureReady?: () => Promise<void>,
  ) {}

  get id(): string {
    return this.container;
  }

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    if (this.ensureReady) {
      await this.ensureReady();
    } else {
      await ensureContainerRunning(this.container);
    }

    const hostExecutor = new HostExecutor();
    const dockerCmd = buildContainerExecCommand(
      this.container,
      withRuntimeBootstrap(command, this.env),
      this.env,
    );
    const hostOptions =
      this.env && Object.keys(this.env).length > 0 ? { ...options, env: this.env } : options;
    return await hostExecutor.exec(dockerCmd, hostOptions);
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

export const containerSandboxProvider: SandboxProvider<ContainerSandboxConfig> = {
  type: "container",
  usage: "container:<container-name>",
  capabilities: {
    lifecycle: "external",
    credentialScope: "instance",
    envInjection: "per-exec",
    fileMounts: false,
    filePush: false,
    egressBroker: false,
  },
  parse: parseContainerSandboxArg,
  validate: validateContainerSandbox,
  getPathContext: (_config, hostWorkspaceRoot) =>
    createMountedRuntimePathContext(hostWorkspaceRoot, "/workspace"),
  instanceScopeKey: (config) => `container-${config.container}`,
  acquire: (config, ctx) => new ContainerExecutor(config.container, ctx.env),
  attach: (config, env, ensureReady) => new ContainerExecutor(config.container, env, ensureReady),
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
