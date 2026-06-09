import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ContainerSandboxConfig,
  ExecOptions,
  ExecResult,
  Executor,
  RuntimePathContext,
  SandboxAdapter,
  SandboxSecrets,
} from "./types.js";
import { SandboxError } from "./errors.js";
import { execSimple, shellEscape } from "./utils.js";
import { HostExecutor } from "./host.js";
import { createMountedRuntimePathContext } from "./path-context.js";
import { parseProxyHeaderRules } from "./proxy.js";

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

function buildContainerExecCommand(
  container: string,
  command: string,
  envFilePath?: string,
): string {
  const envPart = envFilePath ? `--env-file ${shellEscape(envFilePath)} ` : "";
  return `docker exec ${envPart}-w /workspace ${container} sh -c ${shellEscape(command)}`;
}

function withRuntimeBootstrap(command: string, secrets?: SandboxSecrets): string {
  return stageProxyInjection(command, secrets);
}

function stageProxyInjection(command: string, secrets?: SandboxSecrets): string {
  const rules = parseProxyHeaderRules(secrets?.env);
  if (!rules) return command;
  const payload = Buffer.from(JSON.stringify(rules), "utf-8").toString("base64");
  return [
    "proxy_dir=$(mktemp -d /tmp/mikan-proxy.XXXXXX)",
    'proxy_cleanup() { [ ! -f "$proxy_dir/pid" ] || kill "$(cat "$proxy_dir/pid")" 2>/dev/null || true; rm -rf "$proxy_dir"; }',
    `base64 -d > "$proxy_dir/proxy.mjs" <<'MIKAN_PROXY'\n${proxyScriptBase64()}\nMIKAN_PROXY`,
    `MIKAN_PROXY_RULES_B64=${shellEscape(payload)} node "$proxy_dir/proxy.mjs" "$proxy_dir/port" & echo $! > "$proxy_dir/pid"`,
    'while [ ! -s "$proxy_dir/port" ]; do sleep 0.05; done',
    'export HTTP_PROXY="http://127.0.0.1:$(cat "$proxy_dir/port")"',
    'export http_proxy="$HTTP_PROXY"',
    command,
    "proxy_status=$?",
    "proxy_cleanup",
    "exit $proxy_status",
  ].join("\n");
}

function proxyScriptBase64(): string {
  return Buffer.from(INLINE_PROXY_SCRIPT, "utf-8").toString("base64");
}

const INLINE_PROXY_SCRIPT = String.raw`import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { writeFileSync } from 'node:fs';
const rules = JSON.parse(Buffer.from(process.env.MIKAN_PROXY_RULES_B64 || '', 'base64').toString('utf8'));
const server = createServer((req, res) => {
  if (!req.url || !/^https?:\/\//.test(req.url)) { res.writeHead(400); res.end('absolute URL required'); return; }
  const target = new URL(req.url);
  for (const [key, value] of Object.entries(rules[target.host] || {})) req.headers[key.toLowerCase()] = value;
  const requestImpl = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const upstream = requestImpl(target, { method: req.method, headers: req.headers }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  upstream.on('error', (error) => { res.writeHead(502); res.end(error.message); });
  req.pipe(upstream);
});
server.on('connect', (_req, client) => {
  client.end('HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\nMIKAN_PROXY_INJECT_HEADERS supports HTTP proxy requests only; HTTPS CONNECT cannot be modified.\n');
});
server.listen(0, '127.0.0.1', () => writeFileSync(process.argv[2], String(server.address().port)));
`;

export class ContainerExecutor implements Executor {
  constructor(
    private container: string,
    private secrets?: SandboxSecrets,
    private ensureReady?: () => Promise<void>,
  ) {}

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    if (this.ensureReady) {
      await this.ensureReady();
    } else {
      await ensureContainerRunning(this.container);
    }

    const hostExecutor = new HostExecutor();
    const env = this.buildCommandEnv();
    const temp = env ? createSecureEnvFile(env) : undefined;
    try {
      const dockerCmd = buildContainerExecCommand(
        this.container,
        withRuntimeBootstrap(command, this.secrets),
        temp?.envFilePath,
      );
      return await hostExecutor.exec(dockerCmd, options);
    } finally {
      temp?.cleanup();
    }
  }

  private buildCommandEnv(): undefined {
    return undefined;
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
  createExecutor: (config, secrets, ensureReady) =>
    new ContainerExecutor(config.container, secrets, ensureReady),
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
