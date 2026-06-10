import type {
  CloudflareSandboxConfig,
  ExecOptions,
  ExecResult,
  RuntimePathContext,
} from "../types.js";
import type { SandboxInstance, SandboxProvider } from "../spi.js";
import { readEnv } from "../../utils/env.js";
import { sanitizeScopeSegment } from "../scope.js";
import { SandboxError } from "../errors.js";

const DEFAULT_CLOUDFLARE_CWD = "/workspace";

interface CloudflareExecPayload {
  sandboxId: string;
  command: string;
  timeoutSeconds?: number;
  cwd?: string;
  env?: Record<string, string>;
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

/** Derive the per-scope remote sandbox id from the configured base id. */
function deriveCloudflareSandboxId(baseSandboxId: string, scopeKey: string): string {
  return `${baseSandboxId}-${sanitizeScopeSegment(scopeKey)}`;
}

export class CloudflareSandboxExecutor implements SandboxInstance {
  private readonly cwd: string;

  constructor(
    private readonly sandboxId: string,
    private readonly env?: Record<string, string>,
    _ensureReady?: () => Promise<void>,
  ) {
    this.cwd = readEnv("CLOUDFLARE_SANDBOX_CWD") || DEFAULT_CLOUDFLARE_CWD;
  }

  get id(): string {
    return this.sandboxId;
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
      const payload: CloudflareExecPayload = {
        sandboxId: this.sandboxId,
        command,
        cwd: this.cwd,
      };
      if (options?.timeout) payload.timeoutSeconds = options.timeout;
      if (this.env && Object.keys(this.env).length > 0) payload.env = this.env;

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

export const cloudflareSandboxProvider: SandboxProvider<CloudflareSandboxConfig> = {
  type: "cloudflare",
  usage: "cloudflare:<sandbox-id>",
  capabilities: {
    lifecycle: "managed",
    credentialScope: "conversation",
    envInjection: "per-exec",
    fileMounts: false,
  },
  parse: parseCloudflareSandboxArg,
  validate: validateCloudflareSandbox,
  getPathContext: (_config, hostWorkspaceRoot) => ({
    hostWorkspaceRoot,
    runtimeWorkspaceRoot: readEnv("CLOUDFLARE_SANDBOX_CWD") || DEFAULT_CLOUDFLARE_CWD,
  }),
  acquire: (config, ctx) =>
    new CloudflareSandboxExecutor(
      deriveCloudflareSandboxId(config.sandboxId, ctx.scopeKey),
      ctx.env,
    ),
  attach: (config, env, ensureReady) =>
    new CloudflareSandboxExecutor(config.sandboxId, env, ensureReady),
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
