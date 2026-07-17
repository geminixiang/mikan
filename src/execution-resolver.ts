import { join } from "path";
import {
  conversationSettingsPath,
  loadGlobalSettings,
  resolveConversationSettings,
} from "./config.js";
import { ensureDirExists, isRecord, readJsonFileIfExists } from "./utils/file-guards.js";
import { DockerContainerManager, type ContainerMount } from "./provisioner.js";
import { createExecutor, type Executor, type SandboxConfig } from "./sandbox/index.js";
import { reportUserFacingError } from "./observability/sentry.js";
import { normalizeSharedVaultName, type VaultManager } from "./vault/index.js";
import { resolveVaultInjection, type VaultInjection } from "./vault/injection.js";
import { allowsAmbientDefaultSharedVault } from "./vault/policy.js";
import { actorKey, scopeCloudflareSandboxId } from "./sandbox/identity.js";
import type { ResolvedVaultMount } from "./vault/types.js";
import * as log from "./log.js";

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
    return (
      resolveConversationSettings(conversationDir).sandbox?.image?.workspaceMount ?? globalDefault
    );
  } catch (err) {
    log.logWarning(
      "Falling back while resolving conversation workspace mount",
      err instanceof Error ? err.message : String(err),
    );
    const raw = readConversationSettingsFallback(conversationSettingsPath(conversationDir));
    return raw?.sandbox?.image?.workspaceMount ?? globalDefault;
  }
}

function readGlobalWorkspaceMountMode(): ImageWorkspaceMountMode {
  try {
    return loadGlobalSettings().sandbox?.image?.workspaceMount ?? "private";
  } catch (err) {
    log.logWarning(
      "Using default workspace mount because global settings could not be read",
      err instanceof Error ? err.message : String(err),
    );
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
  } catch (err) {
    log.logWarning(
      "Ignoring malformed conversation settings fallback while resolving workspace mount",
      err instanceof Error ? err.message : String(err),
    );
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
    private hostWorkspacePath?: string,
  ) {}

  async resolve(context: ActorContext): Promise<Executor> {
    const vaultKey = actorKey(this.baseConfig, {
      userId: context.userId,
      conversationId: context.conversationId,
    });
    this.ensureDefaultSharedVault(vaultKey, context.trustModel);

    const vault = this.vaultManager.resolve(vaultKey);
    // The vault decides what it contributes (env, validated credential
    // mounts); this resolver only composes that with workspace layout and
    // per-actor config shaping.
    const injection = resolveVaultInjection({
      vault,
      sandboxType: this.baseConfig.type,
      conversationId: context.conversationId,
    });
    const config = this.resolveSandboxConfig(vaultKey, context.conversationId, injection);
    return createExecutor(
      config,
      injection.env,
      this.buildEnsureReadyCallback(vaultKey, context.conversationId, config, injection),
    );
  }

  private ensureDefaultSharedVault(vaultKey: string, trustModel: ActorContext["trustModel"]): void {
    if (
      !allowsAmbientDefaultSharedVault({
        trustModel,
        sandboxType: this.baseConfig.type,
      })
    ) {
      return;
    }
    if (this.vaultManager.hasEntry(vaultKey)) return;

    let profile: string | undefined;
    try {
      profile = loadGlobalSettings().sandbox?.defaultSharedVault;
    } catch {
      return;
    }
    if (!profile || normalizeSharedVaultName(profile) !== profile) return;

    this.vaultManager.copySharedVaultTo(profile, vaultKey);
  }

  private resolveSandboxConfig(
    vaultKey: string,
    conversationId: string,
    injection: VaultInjection,
  ): SandboxConfig {
    if (this.baseConfig.type === "cloudflare") {
      return {
        type: "cloudflare",
        sandboxId: scopeCloudflareSandboxId(this.baseConfig.sandboxId, vaultKey),
      };
    }
    if (this.baseConfig.type === "gondolin") {
      return {
        ...this.baseConfig,
        workspacePath: this.hostWorkspacePath,
        mounts: this.resolveMounts(conversationId, injection.mounts),
        instanceId: vaultKey,
        resourceKey: vaultKey,
      };
    }
    if (this.baseConfig.type !== "image") {
      return this.baseConfig;
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
    injection: VaultInjection,
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
          mounts: this.resolveMounts(conversationId, injection.mounts),
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
            hasVault: Boolean(injection.env || injection.mounts.length > 0),
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

  /** Workspace layout overlaid by the vault's (already validated) credential mounts. */
  private resolveMounts(
    conversationId: string,
    vaultMounts: ResolvedVaultMount[],
  ): ContainerMount[] {
    const mountsByTarget = new Map<string, ContainerMount>();
    for (const mount of this.buildWorkspaceMounts(conversationId)) {
      mountsByTarget.set(mount.target, mount);
    }
    for (const mount of vaultMounts) {
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
