import { VM, createHttpHooks } from "@earendil-works/gondolin";
import type { ExecResult as GondolinExecResult, VMOptions } from "@earendil-works/gondolin";
import { readEnv } from "../../utils/env.js";
import { SandboxError } from "../errors.js";
import type { SandboxFs, SandboxInstance, SandboxProvider } from "../spi.js";
import type {
  ExecOptions,
  ExecResult,
  GondolinSandboxConfig,
  RuntimePathContext,
} from "../types.js";

const DEFAULT_GONDOLIN_CWD = "/workspace";

function parseGondolinSandboxArg(value: string): GondolinSandboxConfig | undefined {
  if (value === "gondolin") return { type: "gondolin" };
  if (!value.startsWith("gondolin:")) return undefined;

  const profile = value.slice("gondolin:".length).trim();
  if (!profile) {
    throw new SandboxError("Error: gondolin sandbox profile cannot be empty");
  }
  return { type: "gondolin", profile };
}

async function validateGondolinSandbox(_config: GondolinSandboxConfig): Promise<void> {
  return Promise.resolve();
}

class GondolinSandboxExecutor implements SandboxInstance {
  private readonly cwd: string;

  constructor(
    private readonly config: GondolinSandboxConfig,
    private readonly vm: VM,
  ) {
    this.cwd = readEnv("GONDOLIN_SANDBOX_CWD") || DEFAULT_GONDOLIN_CWD;
  }

  get id(): string {
    return this.vm.id;
  }

  get fs(): SandboxFs {
    return {
      mkdir: async (path) => {
        await this.vm.fs.mkdir(path, { recursive: true, mode: 0o700 });
      },
      writeFile: async (path, content) => {
        await this.vm.fs.writeFile(path, content);
      },
    };
  }

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    const result = await this.vm.exec(command, {
      cwd: this.cwd,
      env: options?.env,
      signal: options?.signal,
    });
    return mapGondolinExecResult(result);
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

  getSandboxConfig(): GondolinSandboxConfig {
    return this.config;
  }

  async destroy(): Promise<void> {
    await this.vm.close();
  }
}

export const gondolinSandboxProvider: SandboxProvider<GondolinSandboxConfig> = {
  type: "gondolin",
  usage: "gondolin[:profile]",
  capabilities: {
    lifecycle: "managed",
    credentialScope: "conversation",
    envInjection: "at-create",
    fileMounts: false,
    filePush: true,
  },
  parse: parseGondolinSandboxArg,
  validate: validateGondolinSandbox,
  getPathContext: (_config, hostWorkspaceRoot) => ({
    hostWorkspaceRoot,
    runtimeWorkspaceRoot: readEnv("GONDOLIN_SANDBOX_CWD") || DEFAULT_GONDOLIN_CWD,
  }),
  acquire: async (config, ctx) => {
    const vm = await VM.create(buildGondolinOptions(config, ctx.env));
    return new GondolinSandboxExecutor(config, vm);
  },
  attach: () => {
    throw new SandboxError(
      "Error: gondolin sandbox requires actor context; use ActorExecutionResolver",
    );
  },
};

function buildGondolinOptions(
  config: GondolinSandboxConfig,
  env?: Record<string, string>,
): VMOptions {
  const hookHosts = readCommaSeparatedEnv("GONDOLIN_SECRET_HOSTS");
  if (hookHosts.length === 0) {
    return {
      env,
      sessionLabel: config.profile ? `mikan:${config.profile}` : "mikan",
    };
  }

  const hooks = createHttpHooks({
    allowedHosts: readCommaSeparatedEnv("GONDOLIN_ALLOWED_HOSTS"),
    secrets: Object.fromEntries(
      Object.entries(env ?? {}).map(([name, value]) => [name, { value, hosts: hookHosts }]),
    ),
  });

  return {
    env: hooks.env,
    httpHooks: hooks.httpHooks,
    sessionLabel: config.profile ? `mikan:${config.profile}` : "mikan",
  };
}

function mapGondolinExecResult(result: GondolinExecResult): ExecResult {
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    code: result.exitCode,
  };
}

function readCommaSeparatedEnv(name: string): string[] {
  const raw = readEnv(name);
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}
