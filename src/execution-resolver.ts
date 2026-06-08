import { existsSync } from "fs";
import { join } from "path";
import { loadGlobalSettings, resolveConversationSettings } from "./config.js";
import { ensureDirExists, isRecord, readJsonFileIfExists } from "./utils/file-guards.js";
import { DockerContainerManager, type ContainerMount } from "./provisioner.js";
import {
  createExecutor,
  type Executor,
  type SandboxConfig,
  type SandboxSecrets,
} from "./sandbox/index.js";
import { reportUserFacingError } from "./observability/sentry.js";
import { normalizeSharedVaultName, type ResolvedVault, type VaultManager } from "./vault/index.js";
import { resolveActorVaultKey } from "./vault/routing.js";

export type { ActorContext, ImageWorkspaceMountMode } from "./types.js";
import type { ActorContext, ImageWorkspaceMountMode } from "./types.js";

export function readConversationWorkspaceMountMode(
  workspaceDir: string | undefined,
  conversationId: string,
): ImageWorkspaceMountMode {
  const globalDefault = readGlobalWorkspaceMountMode();
  if (!workspaceDir) {
    return globalDefault;
  }

  const conversationDir = join(workspaceDir, conversationId);
  try {
    return resolveConversationSettings(conversationDir).sandboxImageWorkspaceMount ?? globalDefault;
  } catch {
    const conversationSettingsPath = join(conversationDir, "settings.json");
    const raw = readConversationSettingsFallback(conversationSettingsPath);
    return raw?.sandbox?.image?.workspaceMount ?? globalDefault;
  }
}

function readGlobalWorkspaceMountMode(): ImageWorkspaceMountMode {
  try {
    return loadGlobalSettings().sandboxImageWorkspaceMount ?? "private";
  } catch {
    return "private";
  }
}

function readConversationSettingsFallback(
  settingsPath: string,
): { sandbox?: { image?: { workspaceMount?: ImageWorkspaceMountMode } } } | undefined {
  try {
    return readJsonFileIfExists(
      settingsPath,
      (value): value is { sandbox?: { image?: { workspaceMount?: ImageWorkspaceMountMode } } } =>
        isRecord(value),
      () => "Ignoring malformed conversation settings file while resolving workspace mount",
    );
  } catch {
    return undefined;
  }
}

export class ActorExecutionResolver {
  private readonly ensuredConversationDirs = new Set<string>();

  constructor(
    private baseConfig: SandboxConfig,
    private vaultManager: VaultManager,
    private provisioner?: DockerContainerManager,
    private workspaceDir?: string,
  ) {}

  async resolve(context: ActorContext): Promise<Executor> {
    const vaultKey = resolveActorVaultKey(this.baseConfig, context.userId, context.conversationId);
    this.ensureDefaultSharedVault(vaultKey);

    const vault = this.vaultManager.resolve(vaultKey);
    const config = this.resolveSandboxConfig(vaultKey);
    const secrets = config.type !== "host" && vault ? this.resolveSecrets(vault) : undefined;
    return createExecutor(
      config,
      secrets,
      this.buildEnsureReadyCallback(vaultKey, context.conversationId, config, vault),
    );
  }

  private ensureDefaultSharedVault(vaultKey: string): void {
    if (
      this.baseConfig.type !== "image" &&
      this.baseConfig.type !== "cloudflare" &&
      this.baseConfig.type !== "gondolin"
    )
      return;
    if (this.vaultManager.hasEntry(vaultKey)) return;

    let profile: string | undefined;
    try {
      profile = loadGlobalSettings().defaultSharedVault;
    } catch {
      return;
    }
    if (!profile || normalizeSharedVaultName(profile) !== profile) return;

    this.vaultManager.copySharedVaultTo(profile, vaultKey);
  }

  private resolveSandboxConfig(vaultKey: string): SandboxConfig {
    const config = this.vaultManager.getSandboxConfig(vaultKey, this.baseConfig);
    if (this.baseConfig.type !== "image") {
      return config;
    }

    if (config.type === "container") {
      return config;
    }

    return {
      type: "container",
      container: DockerContainerManager.containerName(vaultKey),
    };
  }

  private buildEnsureReadyCallback(
    vaultKey: string,
    conversationId: string,
    config: SandboxConfig,
    vault?: ResolvedVault,
  ): (() => Promise<void>) | undefined {
    if (this.baseConfig.type !== "image" || config.type !== "container") {
      return undefined;
    }

    return async () => {
      const expected = config.container || DockerContainerManager.containerName(vaultKey);
      let actual: string | undefined;
      try {
        actual = await this.provisioner?.provision(vaultKey, {
          containerName: expected,
          mounts: this.resolveMounts(conversationId, vault),
          conversationId,
        });
      } catch (err) {
        reportUserFacingError(err, {
          domain: "sandbox",
          surface: "sandbox_provision",
          operation: "ensure_image_container_ready",
          severity: "error",
          context: {
            sandboxType: "image",
            resolvedSandboxType: config.type,
            conversationId,
            vaultKey,
            expectedContainer: expected,
            hasVault: Boolean(vault),
          },
        });
        throw err;
      }
      if (actual && actual !== expected) {
        throw new Error(
          `Provisioner returned container "${actual}" for container key "${vaultKey}", expected "${expected}"`,
        );
      }
    };
  }

  private resolveMounts(conversationId: string, _vault?: ResolvedVault): ContainerMount[] {
    return this.buildImageSandboxMounts(conversationId);
  }

  private resolveSecrets(vault: ResolvedVault): SandboxSecrets | undefined {
    const files = vault.mounts.filter((mount) => {
      if (existsSync(mount.source)) return true;
      reportUserFacingError(new Error("Vault secret source is missing"), {
        domain: "sandbox",
        surface: "vault_runtime_secrets",
        operation: "resolve_secrets",
        severity: "warning",
        context: {
          sandboxType: this.baseConfig.type,
          target: mount.target,
          hasVault: true,
        },
      });
      return false;
    });
    const hasEnv = Object.keys(vault.env).length > 0;
    if (!hasEnv && files.length === 0) return undefined;
    return {
      ...(hasEnv ? { env: vault.env } : {}),
      ...(files.length > 0 ? { files } : {}),
    };
  }

  private buildImageSandboxMounts(conversationId: string): ContainerMount[] {
    if (!this.workspaceDir) {
      return [];
    }

    if (readConversationWorkspaceMountMode(this.workspaceDir, conversationId) === "full") {
      return [{ source: this.workspaceDir, target: "/workspace" }];
    }

    const conversationDir = join(this.workspaceDir, conversationId);
    if (!this.ensuredConversationDirs.has(conversationId)) {
      ensureDirExists(conversationDir);
      this.ensuredConversationDirs.add(conversationId);
    }

    return [
      { source: join(this.workspaceDir, "MEMORY.md"), target: "/workspace/MEMORY.md" },
      { source: join(this.workspaceDir, "skills"), target: "/workspace/skills" },
      { source: join(this.workspaceDir, "events"), target: "/workspace/events" },
      { source: conversationDir, target: `/workspace/${conversationId}` },
    ];
  }
}
