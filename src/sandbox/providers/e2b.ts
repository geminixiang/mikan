import { Sandbox as E2BSandbox } from "@e2b/code-interpreter";
import type {
  CommandResult,
  Sandbox as E2BSandboxInstance,
  SandboxOpts,
} from "@e2b/code-interpreter";
import { readEnv } from "../../utils/env.js";
import { SandboxError } from "../errors.js";
import type { SandboxFs, SandboxInstance, SandboxProvider } from "../spi.js";
import type { E2BSandboxConfig, ExecOptions, ExecResult, RuntimePathContext } from "../types.js";

const DEFAULT_E2B_CWD = "/workspace";
const DEFAULT_E2B_TIMEOUT_MS = 30 * 60 * 1000;

function parseE2BSandboxArg(value: string): E2BSandboxConfig | undefined {
  if (!value.startsWith("e2b:")) return undefined;

  const template = value.slice("e2b:".length).trim();
  if (!template) {
    throw new SandboxError("Error: e2b sandbox requires template id (e.g., e2b:base)");
  }

  return { type: "e2b", template };
}

async function validateE2BSandbox(_config: E2BSandboxConfig): Promise<void> {
  if (!readEnv("E2B_API_KEY")) {
    throw new SandboxError(
      "Error: E2B_API_KEY or MIKAN_E2B_API_KEY is required for e2b sandbox mode",
    );
  }
}

class E2BSandboxExecutor implements SandboxInstance {
  private readonly cwd: string;

  constructor(
    private readonly config: E2BSandboxConfig,
    private readonly sandbox: E2BSandboxInstance,
  ) {
    this.cwd = readEnv("E2B_SANDBOX_CWD") || DEFAULT_E2B_CWD;
  }

  get id(): string {
    return this.sandbox.sandboxId;
  }

  get fs(): SandboxFs {
    return {
      mkdir: async (path) => {
        await this.sandbox.files.makeDir(path);
      },
      writeFile: async (path, content) => {
        await this.sandbox.files.write(path, content);
      },
    };
  }

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    const result = await this.sandbox.commands.run(command, {
      cwd: this.cwd,
      envs: options?.env,
      timeoutMs: options?.timeout ? options.timeout * 1000 : undefined,
      signal: options?.signal,
    });
    return mapCommandResult(result as CommandResult);
  }

  getWorkspacePath(_hostPath: string): string {
    return this.cwd;
  }

  getPathContext(hostWorkspaceRoot: string): RuntimePathContext {
    return {
      hostWorkspaceRoot,
      runtimeWorkspaceRoot: this.cwd,
    };
  }

  getSandboxConfig(): E2BSandboxConfig {
    return this.config;
  }

  async suspend(): Promise<void> {
    await this.sandbox.pause();
  }

  async destroy(): Promise<void> {
    await this.sandbox.kill();
  }
}

export const e2bSandboxProvider: SandboxProvider<E2BSandboxConfig> = {
  type: "e2b",
  usage: "e2b:<template>",
  capabilities: {
    lifecycle: "managed",
    credentialScope: "conversation",
    envInjection: "at-create",
    fileMounts: false,
    filePush: true,
    egressBroker: false,
  },
  parse: parseE2BSandboxArg,
  validate: validateE2BSandbox,
  getPathContext: (_config, hostWorkspaceRoot) => ({
    hostWorkspaceRoot,
    runtimeWorkspaceRoot: readEnv("E2B_SANDBOX_CWD") || DEFAULT_E2B_CWD,
  }),
  acquire: async (config, ctx) => {
    const sandbox = await E2BSandbox.create(config.template, buildE2BSandboxOpts(ctx.env));
    return new E2BSandboxExecutor(config, sandbox);
  },
  attach: () => {
    throw new SandboxError(
      "Error: e2b:<template> requires actor context; use ActorExecutionResolver",
    );
  },
};

function buildE2BSandboxOpts(env?: Record<string, string>): SandboxOpts {
  return {
    envs: env,
    metadata: { managedBy: "mikan" },
    timeoutMs: readPositiveIntegerEnv("E2B_SANDBOX_TIMEOUT_MS") ?? DEFAULT_E2B_TIMEOUT_MS,
  };
}

function mapCommandResult(result: CommandResult): ExecResult {
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || result.error || "",
    code: result.exitCode,
  };
}

function readPositiveIntegerEnv(name: string): number | undefined {
  const raw = readEnv(name);
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
