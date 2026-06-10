import { existsSync } from "fs";
import { join } from "path";
import { loadGlobalSettings, resolveConversationSettings } from "./config.js";
import { ensureDirExists, isRecord, readJsonFileIfExists } from "./utils/file-guards.js";
import {
  createSandboxProviderFor,
  resolveActorScopeKey,
  type ContainerMount,
  type DockerContainerManager,
  type Executor,
  type SandboxConfig,
  type SandboxProvider,
} from "./sandbox/index.js";
import { reportUserFacingError } from "./observability/sentry.js";
import { normalizeSharedVaultName, type ResolvedVault, type VaultManager } from "./vault/index.js";

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

/**
 * Resolves a ready sandbox instance for an actor: derives the credential
 * scope key, seeds and resolves the vault, and delegates runtime acquisition
 * to the sandbox provider. All backend-specific behaviour lives in providers;
 * this class only consults their declared capabilities.
 */
export class ActorExecutionResolver {
  private readonly ensuredConversationDirs = new Set<string>();
  private readonly provider: SandboxProvider;

  constructor(
    private baseConfig: SandboxConfig,
    private vaultManager: VaultManager,
    provisioner?: DockerContainerManager,
    private workspaceDir?: string,
  ) {
    this.provider = createSandboxProviderFor(baseConfig, { provisioner });
  }

  async resolve(context: ActorContext): Promise<Executor> {
    const scopeKey = resolveActorScopeKey(this.baseConfig, context.userId, context.conversationId);
    this.ensureDefaultSharedVault(scopeKey);

    const vault = this.vaultManager.resolve(scopeKey);
    const capabilities = this.provider.capabilities;
    const env =
      capabilities.envInjection !== "none" && vault && Object.keys(vault.env).length > 0
        ? vault.env
        : undefined;
    const mounts = capabilities.fileMounts
      ? this.resolveMounts(context.conversationId, vault)
      : undefined;

    return await this.provider.acquire(this.baseConfig, {
      userId: context.userId,
      conversationId: context.conversationId,
      scopeKey,
      env,
      mounts,
    });
  }

  private ensureDefaultSharedVault(scopeKey: string): void {
    if (this.provider.capabilities.lifecycle !== "managed") return;
    if (this.vaultManager.hasEntry(scopeKey)) return;

    let profile: string | undefined;
    try {
      profile = loadGlobalSettings().defaultSharedVault;
    } catch {
      return;
    }
    if (!profile || normalizeSharedVaultName(profile) !== profile) return;

    this.vaultManager.copySharedVaultTo(profile, scopeKey);
  }

  private resolveMounts(conversationId: string, vault?: ResolvedVault): ContainerMount[] {
    const mountsByTarget = new Map<string, ContainerMount>();
    for (const mount of this.buildWorkspaceMounts(conversationId)) {
      mountsByTarget.set(mount.target, mount);
    }
    for (const mount of vault?.mounts ?? []) {
      if (!existsSync(mount.source)) {
        reportUserFacingError(new Error("Vault mount source is missing"), {
          domain: "sandbox",
          surface: "vault_injection",
          operation: "resolve_mounts",
          severity: "warning",
          context: {
            sandboxType: this.baseConfig.type,
            conversationId,
            target: mount.target,
            hasVault: Boolean(vault),
          },
        });
        continue;
      }
      mountsByTarget.set(mount.target, { source: mount.source, target: mount.target });
    }
    return [...mountsByTarget.values()];
  }

  private buildWorkspaceMounts(conversationId: string): ContainerMount[] {
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
