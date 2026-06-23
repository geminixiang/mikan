import type {
  ExecOptions,
  ExecResult,
  Executor,
  GondolinSandboxConfig,
  RuntimePathContext,
  SandboxAdapter,
  SandboxSecrets,
} from "./types.js";
import { readEnv } from "../utils/env.js";
import { SandboxError } from "./errors.js";
import { buildRemoteSandboxSecrets } from "./remote-secrets.js";

const DEFAULT_GONDOLIN_CWD = "/workspace";

interface GondolinExecPayload {
  sandboxId: string;
  command: string;
  timeoutSeconds?: number;
  cwd?: string;
  env?: Record<string, string>;
  secrets?: SandboxSecrets;
}

interface GondolinExecResponse {
  stdout?: string;
  stderr?: string;
  code?: number;
  error?: string;
}

function parseGondolinSandboxArg(value: string): GondolinSandboxConfig | undefined {
  if (!value.startsWith("gondolin:")) {
    return undefined;
  }

  const sandboxId = value.slice("gondolin:".length).trim();
  if (!sandboxId) {
    throw new SandboxError(
      "Error: gondolin sandbox requires sandbox id (e.g., gondolin:slack-u123)",
    );
  }

  return { type: "gondolin", sandboxId };
}

async function validateGondolinSandbox(_config: GondolinSandboxConfig): Promise<void> {
  const url = resolveGondolinSandboxUrl();
  try {
    const response = await fetch(new URL("/health", url), {
      headers: buildGondolinHeaders(),
    });
    if (!response.ok) {
      throw new SandboxError(
        `Error: Gondolin sandbox bridge health check failed with HTTP ${response.status}`,
      );
    }
  } catch (error) {
    if (error instanceof SandboxError) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new SandboxError(`Error: Gondolin sandbox bridge is not reachable: ${detail}`);
  }

  console.log(`  Gondolin sandbox bridge enabled. Base URL: ${url.toString().replace(/\/$/, "")}`);
}

export class GondolinSandboxExecutor implements Executor {
  private readonly cwd: string;

  constructor(
    private readonly sandboxId: string,
    private readonly secrets?: SandboxSecrets,
    _ensureReady?: () => Promise<void>,
  ) {
    this.cwd = readEnv("GONDOLIN_SANDBOX_CWD") || DEFAULT_GONDOLIN_CWD;
  }

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    const controller = new AbortController();
    const timeoutHandle =
      options?.timeout && options.timeout > 0
        ? setTimeout(() => controller.abort(), options.timeout * 1000)
        : undefined;

    const onAbort = () => controller.abort();
    if (options?.signal) {
      if (options.signal.aborted) {
        controller.abort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    try {
      const payload: GondolinExecPayload = {
        sandboxId: this.sandboxId,
        command,
        cwd: this.cwd,
      };
      const remoteSecrets = buildRemoteSandboxSecrets(this.secrets);
      if (options?.timeout) payload.timeoutSeconds = options.timeout;
      if (remoteSecrets) payload.secrets = remoteSecrets;

      const response = await fetch(new URL("/exec", resolveGondolinSandboxUrl()), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...buildGondolinHeaders(),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const raw = (await response.text()).trim();
      const parsed = raw ? (JSON.parse(raw) as GondolinExecResponse) : {};

      if (!response.ok) {
        throw new Error(
          parsed.error ||
            parsed.stderr ||
            `Gondolin sandbox bridge returned HTTP ${response.status}`,
        );
      }

      return {
        stdout: parsed.stdout || "",
        stderr: parsed.stderr || "",
        code: parsed.code ?? 0,
      };
    } catch (error) {
      if (controller.signal.aborted) {
        if (options?.signal?.aborted) {
          throw new Error("Command aborted", { cause: error });
        }
        throw new Error(`Command timed out after ${options?.timeout} seconds`, { cause: error });
      }
      throw error;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (options?.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }
    }
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
    return { type: "gondolin", sandboxId: this.sandboxId };
  }
}

export const gondolinSandboxAdapter: SandboxAdapter<GondolinSandboxConfig> = {
  type: "gondolin",
  parse: parseGondolinSandboxArg,
  validate: validateGondolinSandbox,
  createExecutor: (config, secrets, ensureReady) =>
    new GondolinSandboxExecutor(config.sandboxId, secrets, ensureReady),
};

function resolveGondolinSandboxUrl(): URL {
  const raw = readEnv("GONDOLIN_SANDBOX_URL");
  if (!raw) {
    throw new SandboxError(
      "Error: GONDOLIN_SANDBOX_URL or MIKAN_GONDOLIN_SANDBOX_URL is required for gondolin sandbox mode",
    );
  }

  try {
    return new URL(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new SandboxError(`Error: invalid GONDOLIN_SANDBOX_URL: ${detail}`);
  }
}

function buildGondolinHeaders(): Record<string, string> {
  const token = readEnv("GONDOLIN_SANDBOX_TOKEN");
  return token ? { authorization: `Bearer ${token}` } : {};
}
