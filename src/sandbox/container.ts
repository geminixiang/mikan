import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { ExecutionError, FileError, err, type ExecutionEnv } from "@earendil-works/pi-durable/env";
import { Connection, RemoteExecutionEnv, packagedDaemon } from "@earendil-works/pi-env";
import type {
  ContainerExecutionEnvOptions,
  ContainerSandboxConfig,
  SandboxAdapter,
} from "./types.js";
import { SandboxError, execSimple } from "./utils.js";
import { containerEngine } from "./engine.js";
import { errorMessage } from "../unknown-values.js";
import * as log from "../log.js";

const execFileAsync = promisify(execFile);

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
  const engine = containerEngine();
  try {
    await execSimple(engine, ["--version"]);
  } catch {
    throw new SandboxError(
      `Error: no container engine found; install nerdctl, Podman, or Docker (tried '${engine}')`,
    );
  }

  try {
    const result = await execSimple(engine, [
      "inspect",
      "-f",
      "{{.State.Running}}",
      config.container,
    ]);
    if (result.trim() !== "true") {
      throw new SandboxError(`Error: Container '${config.container}' is not running.`, [
        `Start it with: ${engine} start ${config.container}`,
      ]);
    }
  } catch (error) {
    if (error instanceof SandboxError) {
      throw error;
    }
    throw new SandboxError(`Error: Container '${config.container}' does not exist.`, [
      `Create it with: ${engine} run -d --name ${config.container} -v <workspace>:/workspace docker.io/library/alpine:latest sleep infinity`,
    ]);
  }

  console.log(`  Container '${config.container}' is running (engine: ${engine}).`);
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

const DAEMON_ARCH: Record<string, "x64" | "arm64"> = {
  x86_64: "x64",
  amd64: "x64",
  aarch64: "arm64",
  arm64: "arm64",
};

const INSTALL_DAEMON =
  '[ -x "$1" ] && exit 0; cat > "$1.$$" && chmod 755 "$1.$$" && mv -f "$1.$$" "$1"';

async function deployDaemon(engine: string, container: string): Promise<string> {
  const { stdout } = await execFileAsync(engine, ["exec", container, "uname", "-m"]);
  const arch = DAEMON_ARCH[stdout.trim()];
  if (!arch) throw new Error(`No pi-env daemon for ${stdout.trim()} in container ${container}`);
  const binary = readFileSync(packagedDaemon({ platform: "linux", arch }));
  const digest = createHash("sha256").update(binary).digest("hex").slice(0, 16);
  const path = `/tmp/mikan-pi-env-${digest}`;
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      engine,
      ["exec", "-i", container, "sh", "-c", INSTALL_DAEMON, "sh", path],
      (error) => (error ? reject(error) : resolve()),
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(binary);
  });
  return path;
}

interface ContainerConnection {
  connection: Connection;
  ensureReady: () => Promise<void>;
}

const connections = new Map<string, ContainerConnection>();

function containerConnection(
  engine: string,
  container: string,
  ensureReady: () => Promise<void>,
): Connection {
  const key = `${engine}\0${container}`;
  const existing = connections.get(key);
  if (existing) {
    existing.ensureReady = ensureReady;
    return existing.connection;
  }
  const entry: ContainerConnection = {
    ensureReady,
    connection: new Connection({
      command: async () => {
        await entry.ensureReady();
        return [engine, "exec", "-i", container, await deployDaemon(engine, container)];
      },
      onLog: (text) => log.logWarning(`Sandbox ${container}`, text.trim()),
    }),
  };
  connections.set(key, entry);
  return entry.connection;
}

const PATH_ONLY = new Set<PropertyKey>(["absolutePath", "joinPath"]);

function readiedEnv(
  env: RemoteExecutionEnv,
  ensureReady: () => Promise<void>,
  markUsed: () => void,
): ExecutionEnv {
  let ready: Promise<void> | undefined;
  const before = async () => {
    ready ??= ensureReady().catch((error: unknown) => {
      ready = undefined;
      throw error;
    });
    await ready;
    markUsed();
  };
  return new Proxy(env, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (PATH_ONLY.has(property)) return value.bind(target);
      return async (...args: unknown[]) => {
        try {
          await before();
        } catch (error) {
          const message = errorMessage(error);
          if (property === "cleanup") return undefined;
          return err(
            property === "exec"
              ? new ExecutionError("unknown", message)
              : new FileError("unknown", message),
          );
        }
        return Reflect.apply(value, target, args);
      };
    },
  });
}

export function createContainerExecutionEnv(options: ContainerExecutionEnvOptions): ExecutionEnv {
  const engine = options.engine ?? containerEngine();
  const ensureReady =
    options.ensureReady ?? (() => ensureContainerRunning(options.container, engine));
  const env = new RemoteExecutionEnv({
    connection: containerConnection(engine, options.container, ensureReady),
    id: `container:${options.container}`,
    cwd: options.cwd,
    shellEnv: withGitHubCredentialHelper(options.env),
  });
  return readiedEnv(env, ensureReady, options.markUsed ?? (() => {}));
}

export const containerSandboxAdapter: SandboxAdapter<ContainerSandboxConfig> = {
  type: "container",
  credentials: { env: true, fileMounts: false },
  workspace: { managedProjection: false },
  parse: parseContainerSandboxArg,
  validate: validateContainerSandbox,
  createEnv: (config, options) =>
    createContainerExecutionEnv({ ...options, container: config.container }),
};

async function ensureContainerRunning(container: string, engine: string): Promise<void> {
  try {
    const running = await execSimple(engine, ["inspect", "-f", "{{.State.Running}}", container]);
    if (running.trim() === "true") {
      return;
    }
    await execSimple(engine, ["start", container]);
  } catch (error) {
    const details = errorMessage(error);
    throw new Error(
      `Container "${container}" is not available. ` +
        `Expected a pre-existing container or image provisioning to keep it running.\n${details}`.trim(),
      { cause: error },
    );
  }
}
