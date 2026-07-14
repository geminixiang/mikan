import type { VM as GondolinVM } from "@earendil-works/gondolin";
import { dirname } from "node:path";
import * as log from "../log.js";
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

interface MicrovmSession {
  vm: Promise<VM>;
  activeOperations: number;
  lastUsed: number;
  idleWaiters: Array<() => void>;
}

const MINIMUM_NODE_VERSION = [23, 6, 0] as const;
const MIKAN_IMAGE = "mikan-sandbox:latest";
const sessions = new Map<string, MicrovmSession>();

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

function getSession(key: string, workspacePath: string): MicrovmSession {
  const existing = sessions.get(key);
  if (existing) return existing;

  let session: MicrovmSession;
  const vm = createVM(workspacePath).catch((error) => {
    if (sessions.get(key) === session) sessions.delete(key);
    throw error;
  });
  session = { vm, activeOperations: 0, lastUsed: Date.now(), idleWaiters: [] };
  sessions.set(key, session);
  return session;
}

async function withVM<T>(
  key: string,
  workspacePath: string,
  operation: (vm: VM) => Promise<T>,
): Promise<T> {
  const session = getSession(key, workspacePath);
  session.activeOperations += 1;
  try {
    return await operation(await session.vm);
  } finally {
    session.activeOperations -= 1;
    session.lastUsed = Date.now();
    if (session.activeOperations === 0) {
      for (const resolve of session.idleWaiters.splice(0)) resolve();
    }
  }
}

function waitForIdle(session: MicrovmSession): Promise<void> {
  if (session.activeOperations === 0) return Promise.resolve();
  return new Promise((resolve) => session.idleWaiters.push(resolve));
}

async function closeSession(
  key: string,
  session: MicrovmSession,
  waitForActiveOperations = false,
): Promise<void> {
  if (sessions.get(key) !== session) return;
  sessions.delete(key);
  try {
    if (waitForActiveOperations) await waitForIdle(session);
    const vm = await session.vm;
    await vm.close();
  } catch (error) {
    log.logWarning(
      `Failed to close microVM session '${key}'`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function stopIdleMicrovms(maxIdleMs: number, now = Date.now()): Promise<void> {
  const idle = Array.from(sessions.entries()).filter(
    ([, session]) => session.activeOperations === 0 && now - session.lastUsed >= maxIdleMs,
  );
  await Promise.all(idle.map(([key, session]) => closeSession(key, session)));
}

export async function closeAllMicrovms(): Promise<void> {
  const current = Array.from(sessions.entries());
  await Promise.all(current.map(([key, session]) => closeSession(key, session, true)));
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
    return withVM(this.sessionKey, this.workspacePath, async (vm) => {
      const result = await vm.exec(command, {
        cwd: "/workspace",
        signal: executionSignal(options),
      });
      return { stdout: result.stdout, stderr: result.stderr, code: result.exitCode };
    });
  }

  async readFile(path: string): Promise<string> {
    return withVM(this.sessionKey, this.workspacePath, (vm) =>
      vm.fs.readFile(path, { encoding: "utf8" }),
    );
  }

  async writeFile(path: string, content: string): Promise<void> {
    return withVM(this.sessionKey, this.workspacePath, async (vm) => {
      const stage = `${path}.mikan-stage`;
      await vm.fs.mkdir(dirname(path), { recursive: true });
      await vm.fs.writeFile(stage, content);
      await vm.fs.rename(stage, path);
    });
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
