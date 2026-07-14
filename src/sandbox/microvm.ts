import type { VM as GondolinVM } from "@earendil-works/gondolin";
import { dirname } from "node:path";
import { SandboxError } from "./errors.js";
import { createMountedRuntimePathContext } from "./path-context.js";
import type {
  ExecOptions,
  ExecResult,
  Executor,
  MicrovmSandboxConfig,
  RuntimePathContext,
  SandboxAdapter,
} from "./types.js";

type GondolinModule = typeof import("@earendil-works/gondolin");
type VM = GondolinVM;

const MINIMUM_NODE_VERSION = [23, 6, 0] as const;
const MIKAN_IMAGE = "mikan-sandbox:latest";
const sessions = new Map<string, Promise<VM>>();

function parseMicrovmSandboxArg(value: string): MicrovmSandboxConfig | undefined {
  if (!value.startsWith("microvm:")) return undefined;

  const profile = value.slice("microvm:".length);
  if (!profile) {
    throw new SandboxError("Error: microvm sandbox requires a profile (e.g., microvm:default)");
  }
  if (profile !== "default") {
    throw new SandboxError(
      `Error: unsupported microvm profile '${profile}'. Use 'microvm:default'`,
    );
  }
  return { type: "microvm", profile };
}

function assertSupportedNodeVersion(): void {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major < MINIMUM_NODE_VERSION[0] || (major === MINIMUM_NODE_VERSION[0] && minor < 6)) {
    throw new SandboxError(
      `Error: microvm:default requires Node.js >=23.6.0 (current: ${process.versions.node}). Other sandbox modes remain available on Node.js >=22.19.0.`,
    );
  }
}

async function validateMicrovmSandbox(): Promise<void> {
  assertSupportedNodeVersion();
  console.log("  Gondolin microVM enabled. Profile: default");
}

async function createVM(workspacePath: string): Promise<VM> {
  const { RealFSProvider, VM } = (await import("@earendil-works/gondolin")) as GondolinModule;
  return VM.create({
    sandbox: { imagePath: MIKAN_IMAGE },
    env: { TZ: "Asia/Taipei" },
    vfs: { mounts: { "/workspace": new RealFSProvider(workspacePath) } },
  });
}

function getVM(key: string, workspacePath: string): Promise<VM> {
  const existing = sessions.get(key);
  if (existing) return existing;

  const pending = createVM(workspacePath).catch((error) => {
    sessions.delete(key);
    throw error;
  });
  sessions.set(key, pending);
  return pending;
}

function executionSignal(options?: ExecOptions): AbortSignal | undefined {
  const signals = [options?.signal];
  if (options?.timeout && options.timeout > 0) {
    signals.push(AbortSignal.timeout(options.timeout * 1000));
  }
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  return active.length > 0 ? AbortSignal.any(active) : undefined;
}

export class MicrovmExecutor implements Executor {
  private readonly workspacePath: string;
  private readonly sessionKey: string;

  constructor(private readonly config: MicrovmSandboxConfig) {
    assertSupportedNodeVersion();
    this.workspacePath = config.workspacePath ?? process.cwd();
    this.sessionKey = config.instanceId ?? this.workspacePath;
  }

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    const vm = await getVM(this.sessionKey, this.workspacePath);
    const result = await vm.exec(command, {
      cwd: "/workspace",
      signal: executionSignal(options),
    });
    return { stdout: result.stdout, stderr: result.stderr, code: result.exitCode };
  }

  async readFile(path: string): Promise<string> {
    const vm = await getVM(this.sessionKey, this.workspacePath);
    return vm.fs.readFile(path, { encoding: "utf8" });
  }

  async writeFile(path: string, content: string): Promise<void> {
    const vm = await getVM(this.sessionKey, this.workspacePath);
    const stage = `${path}.mikan-stage`;
    await vm.fs.mkdir(dirname(path), { recursive: true });
    await vm.fs.writeFile(stage, content);
    await vm.fs.rename(stage, path);
  }

  getWorkspacePath(): string {
    return "/workspace";
  }

  getPathContext(hostWorkspaceRoot: string): RuntimePathContext {
    return createMountedRuntimePathContext(hostWorkspaceRoot, "/workspace");
  }

  getSandboxConfig(): MicrovmSandboxConfig {
    return this.config;
  }
}

export const microvmSandboxAdapter: SandboxAdapter<MicrovmSandboxConfig> = {
  type: "microvm",
  parse: parseMicrovmSandboxArg,
  validate: validateMicrovmSandbox,
  createExecutor: (config) => new MicrovmExecutor(config),
};
