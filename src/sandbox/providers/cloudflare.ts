import type {
  CloudflareSandboxConfig,
  ExecOptions,
  ExecResult,
  RuntimePathContext,
} from "../types.js";
import type { SandboxFs, SandboxInstance, SandboxProvider } from "../spi.js";
import { readEnv } from "../../utils/env.js";
import { sanitizeScopeSegment } from "../scope.js";
import { SandboxError } from "../errors.js";

const DEFAULT_CLOUDFLARE_CWD = "/workspace";

interface CloudflareExecPayload {
  sandboxId: string;
  command: string;
  timeoutSeconds?: number;
  cwd?: string;
  /** Legacy bridges only: session env injection via /env is preferred. */
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
  /** Resolves to "session" once env is pushed, or "legacy" for old bridges without /env. */
  private sessionEnvPromise?: Promise<"session" | "legacy">;

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

  get fs(): SandboxFs {
    return {
      mkdir: async (path) => {
        await this.bridgePost("/mkdir", { sandboxId: this.sandboxId, path });
      },
      writeFile: async (path, content) => {
        await this.bridgePost("/write-file", {
          sandboxId: this.sandboxId,
          path,
          content,
          mode: "600",
        });
      },
    };
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
      const includeLegacyEnv = await this.ensureSessionEnv(controller.signal);
      const payload: CloudflareExecPayload = {
        sandboxId: this.sandboxId,
        command,
        cwd: this.cwd,
      };
      if (options?.timeout) payload.timeoutSeconds = options.timeout;
      if (includeLegacyEnv && this.env) payload.env = this.env;

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

  /**
   * Push vault env to the bridge session once per instance instead of
   * resending secrets in every /exec payload. Returns true when a legacy
   * bridge (no /env endpoint) still needs per-exec env.
   */
  private async ensureSessionEnv(signal?: AbortSignal): Promise<boolean> {
    if (!this.env || Object.keys(this.env).length === 0) {
      return false;
    }

    if (!this.sessionEnvPromise) {
      this.sessionEnvPromise = this.pushSessionEnv(signal).catch((error) => {
        // Allow the next exec to retry instead of caching the failure.
        this.sessionEnvPromise = undefined;
        throw error;
      });
    }
    return (await this.sessionEnvPromise) === "legacy";
  }

  private async pushSessionEnv(signal?: AbortSignal): Promise<"session" | "legacy"> {
    const response = await fetch(new URL("/env", resolveCloudflareSandboxUrl()), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...buildCloudflareHeaders(),
      },
      body: JSON.stringify({ sandboxId: this.sandboxId, env: this.env }),
      signal,
    });
    if (response.ok) {
      return "session";
    }
    if (response.status === 404 || response.status === 405) {
      return "legacy";
    }
    throw new Error(`Cloudflare sandbox bridge /env returned HTTP ${response.status}`);
  }

  private async bridgePost(path: string, body: unknown): Promise<void> {
    const response = await fetch(new URL(path, resolveCloudflareSandboxUrl()), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...buildCloudflareHeaders(),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Cloudflare sandbox bridge ${path} returned HTTP ${response.status}`);
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
    envInjection: "at-create",
    fileMounts: false,
    filePush: true,
    egressBroker: false,
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
