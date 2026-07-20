import { randomUUID } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { posix, relative, resolve, sep } from "node:path";
import { SandboxClient, type Sandbox } from "agentic-sandbox-client";
import * as k8s from "@kubernetes/client-node";
import { withRuntimeBootstrap } from "./container.js";
import { SandboxError } from "./errors.js";
import { createMountedRuntimePathContext } from "./path-context.js";
import { shellEscape } from "./utils.js";
import type {
  AgentSandboxConfig,
  AgentSandboxRuntimeOptions,
  ExecOptions,
  ExecResult,
  Executor,
  RuntimePathContext,
  SandboxAdapter,
} from "./types.js";

interface AgentSandboxSession {
  sandbox: Promise<Sandbox>;
  activeOperations: number;
  lastUsed: number;
  syncedCredentials?: boolean;
}

const MANAGED_LABEL = "mikan.dev/managed";
const RESOURCE_KEY_LABEL = "mikan.dev/resource-key";
const sessions = new Map<string, AgentSandboxSession>();
let runtimeOptions: AgentSandboxRuntimeOptions | undefined;
let client: SandboxClient | undefined;
let coreApi: k8s.CoreV1Api | undefined;
let customObjectsApi: k8s.CustomObjectsApi | undefined;

export function configureAgentSandboxRuntime(options: AgentSandboxRuntimeOptions): void {
  if (options.runtimeClassName !== "kata-qemu") {
    throw new SandboxError(
      `Error: agent-sandbox requires runtimeClassName 'kata-qemu', received '${options.runtimeClassName}'`,
    );
  }
  runtimeOptions = options;
  const kubeConfig = new k8s.KubeConfig();
  kubeConfig.loadFromDefault();
  coreApi = kubeConfig.makeApiClient(k8s.CoreV1Api);
  customObjectsApi = kubeConfig.makeApiClient(k8s.CustomObjectsApi);
  client = new SandboxClient({
    namespace: options.namespace,
    apiUrl: options.apiUrl,
    routerNamespace: options.routerNamespace,
    sandboxReadyTimeout: options.sandboxReadyTimeout,
    enableTracing: false,
  });
}

export async function stopIdleAgentSandboxes(maxIdleMs: number): Promise<void> {
  const now = Date.now();
  const stale = Array.from(sessions.entries()).filter(
    ([, session]) => session.activeOperations === 0 && now - session.lastUsed >= maxIdleMs,
  );
  await Promise.all(stale.map(([key, session]) => closeSession(key, session)));
}

export async function shutdownAgentSandboxes(): Promise<void> {
  await Promise.all(Array.from(sessions.entries(), ([key, session]) => closeSession(key, session)));
}

async function closeSession(key: string, session: AgentSandboxSession): Promise<void> {
  if (sessions.get(key) !== session) return;
  sessions.delete(key);
  const sandbox = await session.sandbox.catch(() => undefined);
  await sandbox?.close();
}

function requireRuntime(): {
  options: AgentSandboxRuntimeOptions;
  client: SandboxClient;
  coreApi: k8s.CoreV1Api;
  customObjectsApi: k8s.CustomObjectsApi;
} {
  if (!runtimeOptions || !client || !coreApi || !customObjectsApi) {
    throw new SandboxError("Error: agent-sandbox runtime is not configured");
  }
  return { options: runtimeOptions, client, coreApi, customObjectsApi };
}

async function createSandbox(config: AgentSandboxConfig): Promise<Sandbox> {
  const runtime = requireRuntime();
  const claimName = await findExistingClaim(config.resourceKey, runtime);
  const sandbox = claimName
    ? await runtime.client.getSandbox(claimName, runtime.options.namespace)
    : await runtime.client.createSandbox(config.warmpool, runtime.options.namespace, {
        labels: {
          [MANAGED_LABEL]: "true",
          [RESOURCE_KEY_LABEL]: config.resourceKey,
        },
      });
  try {
    await verifyKataRuntime(sandbox, runtime);
    return sandbox;
  } catch (error) {
    await sandbox.close();
    throw error;
  }
}

async function findExistingClaim(
  resourceKey: string,
  runtime: ReturnType<typeof requireRuntime>,
): Promise<string | undefined> {
  const result = (await runtime.customObjectsApi.listNamespacedCustomObject({
    group: "extensions.agents.x-k8s.io",
    version: "v1beta1",
    namespace: runtime.options.namespace,
    plural: "sandboxclaims",
    labelSelector: `${MANAGED_LABEL}=true,${RESOURCE_KEY_LABEL}=${resourceKey}`,
  })) as { items?: Array<{ metadata?: { name?: string } }> };
  return result.items?.map((claim) => claim.metadata?.name).find(Boolean);
}

async function verifyKataRuntime(
  sandbox: Sandbox,
  runtime: ReturnType<typeof requireRuntime>,
): Promise<void> {
  const pod = await runtime.coreApi.readNamespacedPod({
    name: sandbox.podName,
    namespace: sandbox.namespace,
  });
  const actual = pod.spec?.runtimeClassName;
  if (actual !== runtime.options.runtimeClassName) {
    throw new SandboxError(
      `Error: Agent Sandbox pod '${sandbox.podName}' uses RuntimeClass '${actual ?? "none"}', expected '${runtime.options.runtimeClassName}'`,
    );
  }
}

async function withSession<T>(
  config: AgentSandboxConfig,
  run: (sandbox: Sandbox, session: AgentSandboxSession) => Promise<T>,
): Promise<T> {
  let session = sessions.get(config.resourceKey);
  if (!session) {
    session = {
      sandbox: createSandbox(config),
      activeOperations: 0,
      lastUsed: Date.now(),
    };
    sessions.set(config.resourceKey, session);
    session.sandbox.catch(() => {
      if (sessions.get(config.resourceKey) === session) sessions.delete(config.resourceKey);
    });
  }

  session.activeOperations += 1;
  try {
    return await run(await session.sandbox, session);
  } finally {
    session.activeOperations -= 1;
    session.lastUsed = Date.now();
  }
}

function callOptions(options?: ExecOptions): { timeout?: number; signal?: AbortSignal } {
  return {
    ...(options?.timeout !== undefined ? { timeout: options.timeout } : {}),
    ...(options?.signal ? { signal: options.signal } : {}),
  };
}

function commandWithEnv(
  command: string,
  env?: Record<string, string>,
): {
  command: string;
  envFile?: { path: string; content: string };
} {
  const bootstrapped = withRuntimeBootstrap(command, env);
  if (!env || Object.keys(env).length === 0) return { command: bootstrapped };

  const exports = Object.entries(env).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid vault environment variable name: ${key}`);
    }
    return `export ${key}=${shellEscape(value)}`;
  });
  const path = `/tmp/mikan-env-${randomUUID()}`;
  return {
    command: `trap 'rm -f ${shellEscape(path)}' EXIT; . ${shellEscape(path)}; ${bootstrapped}`,
    envFile: { path, content: `${exports.join("\n")}\n` },
  };
}

async function syncCredentialMounts(
  sandbox: Sandbox,
  mounts: AgentSandboxConfig["mounts"],
  options?: ExecOptions,
): Promise<void> {
  for (const mount of mounts) {
    const source = resolve(mount.source);
    const stat = await lstat(source);
    if (stat.isSymbolicLink()) {
      throw new Error(`Agent Sandbox credential source must not be a symlink: ${source}`);
    }
    if (stat.isDirectory()) {
      await syncCredentialDirectory(sandbox, source, mount.target, options);
    } else if (stat.isFile()) {
      await uploadCredentialFile(sandbox, source, mount.target, options);
    } else {
      throw new Error(`Unsupported Agent Sandbox credential source: ${source}`);
    }
  }
}

async function syncCredentialDirectory(
  sandbox: Sandbox,
  sourceRoot: string,
  targetRoot: string,
  options?: ExecOptions,
): Promise<void> {
  const entries = await readdir(sourceRoot, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Agent Sandbox credential directory must not contain symlinks: ${sourceRoot}`,
      );
    }
    if (!entry.isFile()) continue;
    const source = resolve(entry.parentPath, entry.name);
    const suffix = relative(sourceRoot, source).split(sep).join(posix.sep);
    await uploadCredentialFile(sandbox, source, posix.join(targetRoot, suffix), options);
  }
}

async function uploadCredentialFile(
  sandbox: Sandbox,
  source: string,
  target: string,
  options?: ExecOptions,
): Promise<void> {
  const sdkOptions = { ...callOptions(options), allowUnsafePaths: true };
  await sandbox.commands.run(`mkdir -p ${shellEscape(posix.dirname(target))}`, sdkOptions);
  await sandbox.files.write(target, await readFile(source), sdkOptions);
  await sandbox.commands.run(`chmod 600 ${shellEscape(target)}`, sdkOptions);
}

function parseAgentSandboxArg(value: string): AgentSandboxConfig | undefined {
  if (!value.startsWith("agent-sandbox:")) return undefined;
  const warmpool = value.slice("agent-sandbox:".length).trim();
  if (!warmpool) {
    throw new SandboxError(
      "Error: agent-sandbox requires a warm pool name (e.g., agent-sandbox:mikan-kata)",
    );
  }
  return { type: "agent-sandbox", warmpool, resourceKey: "default", mounts: [] };
}

export class AgentSandboxExecutor implements Executor {
  constructor(
    private readonly config: AgentSandboxConfig,
    private readonly env?: Record<string, string>,
  ) {}

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    return withSession(this.config, async (sandbox, session) => {
      if (!session.syncedCredentials) {
        await syncCredentialMounts(sandbox, this.config.mounts, options);
        session.syncedCredentials = true;
      }
      const prepared = commandWithEnv(command, this.env);
      if (prepared.envFile) {
        await sandbox.files.write(prepared.envFile.path, prepared.envFile.content, {
          ...callOptions(options),
          allowUnsafePaths: true,
        });
        await sandbox.commands.run(
          `chmod 600 ${shellEscape(prepared.envFile.path)}`,
          callOptions(options),
        );
      }
      const result = await sandbox.commands.run(prepared.command, callOptions(options));
      return { stdout: result.stdout, stderr: result.stderr, code: result.exitCode };
    });
  }

  async readFile(path: string, options?: ExecOptions): Promise<string> {
    return withSession(this.config, async (sandbox) =>
      (
        await sandbox.files.read(path, { ...callOptions(options), allowUnsafePaths: true })
      ).toString("utf8"),
    );
  }

  async readFileBase64(path: string, options?: ExecOptions): Promise<string> {
    return withSession(this.config, async (sandbox) =>
      (
        await sandbox.files.read(path, { ...callOptions(options), allowUnsafePaths: true })
      ).toString("base64"),
    );
  }

  async writeFile(path: string, content: string, options?: ExecOptions): Promise<void> {
    await withSession(this.config, (sandbox) =>
      sandbox.files.write(path, content, { ...callOptions(options), allowUnsafePaths: true }),
    );
  }

  getWorkspacePath(): string {
    return "/workspace";
  }

  getPathContext(hostWorkspaceRoot: string): RuntimePathContext {
    return createMountedRuntimePathContext(hostWorkspaceRoot, "/workspace");
  }

  getSandboxConfig(): AgentSandboxConfig {
    return this.config;
  }
}

export const agentSandboxAdapter: SandboxAdapter<AgentSandboxConfig> = {
  type: "agent-sandbox",
  credentials: { env: true, fileMounts: true },
  parse: parseAgentSandboxArg,
  createExecutor: (config, env) => new AgentSandboxExecutor(config, env),
};
