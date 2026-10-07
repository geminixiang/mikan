import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ContainerSandboxConfig,
  DockerExecFile,
  ExecOptions,
  ExecResult,
  Executor,
  RuntimePathContext,
  SandboxAdapter,
} from "./types.js";
import {
  SandboxError,
  createMountedRuntimePathContext,
  execReadFile,
  execReadFileBase64,
  execSimple,
  execWriteFile,
  shellEscape,
} from "./utils.js";
import { HostExecutor } from "./host.js";
import { GUEST_WORKSPACE_ROOT } from "./layout.js";
import { errorMessage } from "../unknown-values.js";
import * as log from "../log.js";

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

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

const GROUP_FILE_PREFIX = "/tmp/mikan-exec-";

const RUN_IN_PROCESS_GROUP = [
  "if command -v setsid >/dev/null 2>&1; then",
  `setsid sh -c 'echo "$$ $(cut -d" " -f22 /proc/$$/stat)" > "$1"; exec sh -c "$2"' _ "$1" "$2" & wait $!;`,
  'status=$?; rm -f "$1"; exit $status;',
  'fi; exec sh -c "$2"',
].join(" ");

const STOP_RECORDED_GROUP = [
  'stop_group() { read group start < "$1" 2>/dev/null || return 0; rm -f "$1";',
  '[ "$group" -gt 1 ] 2>/dev/null || return 0;',
  '[ "$(cut -d" " -f22 /proc/$group/stat 2>/dev/null)" = "$start" ] || return 0;',
  'kill -s KILL -- -"$group" 2>/dev/null || kill -s KILL -"$group" 2>/dev/null; return 0; };',
].join(" ");

const KILL_PROCESS_GROUP = [
  STOP_RECORDED_GROUP,
  'i=0; while [ ! -s "$1" ] && [ $i -lt 10 ]; do sleep 0.1; i=$((i+1)); done;',
  'stop_group "$1"; exit 0',
].join(" ");

const SWEEP_PROCESS_GROUPS = [
  STOP_RECORDED_GROUP,
  `for file in ${GROUP_FILE_PREFIX}*; do [ -f "$file" ] && stop_group "$file"; done; exit 0`,
].join(" ");

export async function sweepOrphanedCommands(
  containerName: string,
  execFile: DockerExecFile,
): Promise<void> {
  try {
    await execFile("docker", ["exec", containerName, "sh", "-c", SWEEP_PROCESS_GROUPS]);
  } catch (error) {
    log.logWarning(`Could not end leftover commands in ${containerName}`, errorMessage(error));
  }
}

function buildContainerExecCommand(
  container: string,
  command: string,
  groupFile: string,
  envFilePath?: string,
  cwd?: string,
): string {
  const envPart = envFilePath ? `--env-file ${shellEscape(envFilePath)} ` : "";
  const workdir = cwd === undefined ? GUEST_WORKSPACE_ROOT : shellEscape(cwd);
  const script = `${shellEscape(RUN_IN_PROCESS_GROUP)} _ ${shellEscape(groupFile)} ${shellEscape(command)}`;
  return `docker exec ${envPart}-w ${workdir} ${container} sh -c ${script}`;
}

function buildKillProcessGroupCommand(container: string, groupFile: string): string {
  return `docker exec ${container} sh -c ${shellEscape(KILL_PROCESS_GROUP)} _ ${shellEscape(groupFile)}`;
}

const GITHUB_CREDENTIAL_KEY = "credential.https://github.com.helper";

function withGitHubCredentialHelper(
  env?: Record<string, string>,
): Record<string, string> | undefined {
  if (!env || !hasGitHubToken(env) || env.GIT_CONFIG_COUNT !== undefined) {
    return env;
  }
  return {
    ...env,
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: GITHUB_CREDENTIAL_KEY,
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: GITHUB_CREDENTIAL_KEY,
    GIT_CONFIG_VALUE_1: "!gh auth git-credential",
  };
}

function hasGitHubToken(env: Record<string, string>): boolean {
  return Boolean(env.GH_TOKEN || env.GITHUB_TOKEN);
}

export class ContainerExecutor implements Executor {
  private readonly hostExecutor = new HostExecutor();

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

    const env = withGitHubCredentialHelper(this.env);
    const temp = env ? createSecureEnvFile(env) : undefined;
    const groupFile = `${GROUP_FILE_PREFIX}${randomUUID()}`;
    try {
      const dockerCmd = buildContainerExecCommand(
        this.container,
        command,
        groupFile,
        temp?.envFilePath,
        options?.cwd,
      );
      const { cwd: _cwd, ...hostOptions } = options ?? {};
      return await this.hostExecutor.exec(dockerCmd, options ? hostOptions : undefined);
    } catch (error) {
      await this.killProcessGroup(groupFile);
      throw error;
    } finally {
      temp?.cleanup();
    }
  }

  private async killProcessGroup(groupFile: string): Promise<void> {
    try {
      await this.hostExecutor.exec(buildKillProcessGroupCommand(this.container, groupFile));
    } catch (error) {
      log.logWarning(
        `Could not stop a command in container ${this.container}`,
        errorMessage(error),
      );
    }
  }

  readFile(path: string, options?: ExecOptions): Promise<string> {
    return execReadFile(this, path, options);
  }

  readFileBase64(path: string, options?: ExecOptions): Promise<string> {
    return execReadFileBase64(this, path, options);
  }

  writeFile(path: string, content: string, options?: ExecOptions): Promise<void> {
    return execWriteFile(this, path, content, options);
  }

  getWorkspacePath(_hostPath: string): string {
    return GUEST_WORKSPACE_ROOT;
  }

  getPathContext(hostWorkspaceRoot: string): RuntimePathContext {
    return createMountedRuntimePathContext(hostWorkspaceRoot, GUEST_WORKSPACE_ROOT);
  }

  getSandboxConfig(): ContainerSandboxConfig {
    return { type: "container", container: this.container };
  }
}

export const containerSandboxAdapter: SandboxAdapter<ContainerSandboxConfig> = {
  type: "container",
  credentials: { env: true, fileMounts: false },
  workspace: { managedProjection: false },
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
    const details = errorMessage(error);
    throw new Error(
      `Container "${container}" is not available. ` +
        `Expected a pre-existing container or image provisioning to keep it running.\n${details}`.trim(),
      { cause: error },
    );
  }
}

function createSecureEnvFile(env: Record<string, string>): {
  envFilePath: string;
  cleanup: () => void;
} {
  const tempDir = mkdtempSync(join(tmpdir(), "mikan-docker-env-"));
  chmodSync(tempDir, PRIVATE_DIR_MODE);
  const envFilePath = join(tempDir, "env.list");
  const content =
    Object.entries(env)
      .map(([key, value]) => `${key}=${value.replace(/\r?\n/g, "")}`)
      .join("\n") + "\n";
  writeFileSync(envFilePath, content, { encoding: "utf-8", mode: PRIVATE_FILE_MODE });
  chmodSync(envFilePath, PRIVATE_FILE_MODE);

  return {
    envFilePath,
    cleanup: () => {
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}
