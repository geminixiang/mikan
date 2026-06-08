import type {
  CloudflareSandboxConfig,
  ExecOptions,
  ExecResult,
  Executor,
  RuntimePathContext,
  SandboxAdapter,
  SandboxSecrets,
} from "./types.js";
import { readEnv } from "../utils/env.js";
import { SandboxError } from "./errors.js";

const DEFAULT_CLOUDFLARE_CWD = "/workspace";

interface CloudflareExecPayload {
  sandboxId: string;
  command: string;
  timeoutSeconds?: number;
  cwd?: string;
  env?: Record<string, string>;
  secrets?: SandboxSecrets;
}

interface CloudflareExecResponse {
  stdout?: string;
  stderr?: string;
  code?: number;
  error?: string;
}

function parseCloudflareSandboxArg(value: string): CloudflareSandboxConfig | undefined {
  if (!value.startsWith("cloudflare:")) {
    return undefined;
  }

  const sandboxId = value.slice("cloudflare:".length).trim();
  if (!sandboxId) {
    throw new SandboxError(
      "Error: cloudflare sandbox requires sandbox id (e.g., cloudflare:slack-u123)",
    );
  }

  return { type: "cloudflare", sandboxId };
}

async function validateCloudflareSandbox(_config: CloudflareSandboxConfig): Promise<void> {
  const url = resolveCloudflareSandboxUrl();
  try {
    const response = await fetch(new URL("/health", url), {
      headers: buildCloudflareHeaders(),
    });
    if (!response.ok) {
      throw new SandboxError(
        `Error: Cloudflare sandbox bridge health check failed with HTTP ${response.status}`,
      );
    }
  } catch (error) {
    if (error instanceof SandboxError) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new SandboxError(`Error: Cloudflare sandbox bridge is not reachable: ${detail}`);
  }

  console.log(
    `  Cloudflare sandbox bridge enabled. Base URL: ${url.toString().replace(/\/$/, "")}`,
  );
}

export class CloudflareSandboxExecutor implements Executor {
  private readonly cwd: string;

  constructor(
    private readonly sandboxId: string,
    private readonly secrets?: SandboxSecrets,
    _ensureReady?: () => Promise<void>,
  ) {
    this.cwd = readEnv("CLOUDFLARE_SANDBOX_CWD") || DEFAULT_CLOUDFLARE_CWD;
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
      if (this.secrets?.files && this.secrets.files.length > 0) {
        throw new SandboxError(
          "Error: Cloudflare sandbox bridge does not support vault file secrets yet; use env secrets or a container/gondolin sandbox for file-backed credentials",
        );
      }

      const payload: CloudflareExecPayload = {
        sandboxId: this.sandboxId,
        command,
        cwd: this.cwd,
      };
      if (options?.timeout) payload.timeoutSeconds = options.timeout;
      if (this.secrets?.env && Object.keys(this.secrets.env).length > 0)
        payload.env = this.secrets.env;
      if (this.secrets) payload.secrets = this.secrets;

      const response = await fetch(new URL("/exec", resolveCloudflareSandboxUrl()), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...buildCloudflareHeaders(),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const raw = (await response.text()).trim();
      const parsed = raw ? (JSON.parse(raw) as CloudflareExecResponse) : {};

      if (!response.ok) {
        throw new Error(
          parsed.error ||
            parsed.stderr ||
            `Cloudflare sandbox bridge returned HTTP ${response.status}`,
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

  getSandboxConfig(): CloudflareSandboxConfig {
    return { type: "cloudflare", sandboxId: this.sandboxId };
  }
}

export const cloudflareSandboxAdapter: SandboxAdapter<CloudflareSandboxConfig> = {
  type: "cloudflare",
  parse: parseCloudflareSandboxArg,
  validate: validateCloudflareSandbox,
  createExecutor: (config, secrets, ensureReady) =>
    new CloudflareSandboxExecutor(config.sandboxId, secrets, ensureReady),
};

function resolveCloudflareSandboxUrl(): URL {
  const raw = readEnv("CLOUDFLARE_SANDBOX_URL");
  if (!raw) {
    throw new SandboxError(
      "Error: CLOUDFLARE_SANDBOX_URL or MIKAN_CLOUDFLARE_SANDBOX_URL is required for cloudflare sandbox mode",
    );
  }

  try {
    return new URL(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new SandboxError(`Error: invalid CLOUDFLARE_SANDBOX_URL: ${detail}`);
  }
}

function buildCloudflareHeaders(): Record<string, string> {
  const token = readEnv("CLOUDFLARE_SANDBOX_TOKEN");
  return token ? { authorization: `Bearer ${token}` } : {};
}
