import { posix } from "node:path";
import type { Office, Workspace } from "./office/index.js";
import { conversationPackageSkillMounts } from "./packages/index.js";
import { loadGlobalSettings } from "./config.js";
import type { DockerContainerManager, ContainerMount } from "./provisioner.js";
import {
  createExecutor,
  getSandboxAdapter,
  getSandboxCredentialCapabilities,
  getSandboxWorkspaceCapabilities,
  type Executor,
  type SandboxConfig,
} from "./sandbox/index.js";
import { normalizeSharedVaultName, type VaultManager } from "./vault/index.js";
import { allowsAmbientDefaultSharedVault, resolveVaultInjection } from "./vault/index.js";
import {
  credentialAuthorizationKey,
  legacyExactCredentialAuthorizationKey,
  runtimeResourceKey,
} from "./sandbox/identity.js";
import { resolveWorkspaceProjection } from "./workspace-projection/index.js";

export type { ActorContext } from "./types.js";
import type { ActorContext, ExecutionPlan } from "./types.js";

export class ActorExecutionResolver {
  constructor(
    private baseConfig: SandboxConfig,
    private vaultManager: VaultManager,
    private provisioner: DockerContainerManager | undefined,
    private workspace: Workspace,
  ) {}

  async resolve(context: ActorContext): Promise<Executor> {
    const plan = this.resolvePlan(context);
    return createExecutor(
      plan.sandboxConfig,
      plan.env,
      this.buildEnsureReadyCallback(plan, context.address.conversationId),
    );
  }

  private resolvePlan(context: ActorContext): ExecutionPlan {
    const scope = { userId: context.userId, address: context.address };
    const credentialKey = credentialAuthorizationKey(this.baseConfig, scope);
    const legacyCredentialKey = legacyExactCredentialAuthorizationKey(this.baseConfig, scope);
    const resourceKey = runtimeResourceKey(this.baseConfig, {
      userId: context.userId,
      conversationId: context.address.conversationId,
    });
    this.ensureDefaultSharedVault(credentialKey, legacyCredentialKey, context.trustModel);

    const vault =
      this.vaultManager.resolve(credentialKey) ??
      (legacyCredentialKey ? this.vaultManager.resolve(legacyCredentialKey) : undefined);
    const capabilities = getSandboxCredentialCapabilities(this.baseConfig.type);
    const workspaceCapabilities = getSandboxWorkspaceCapabilities(this.baseConfig.type);
    const office = this.workspace.office(context.address);
    const workspaceProjection = resolveWorkspaceProjection(office);
    const injection = resolveVaultInjection({
      vault,
      capabilities,
      sandboxType: this.baseConfig.type,
      address: office.address,
    });
    const mounts = this.resolveMounts(office, injection.mounts, workspaceProjection);
    if (workspaceProjection.doorPolicy === "isolated" && !workspaceCapabilities.managedProjection) {
      throw new Error(
        `Sandbox '${this.baseConfig.type}' cannot provide an isolated conversation office; use image:* or gondolin:default, or explicitly choose trusted workspace policy`,
      );
    }
    return {
      credentialKey,
      resourceKey,
      sandboxConfig: this.resolveSandboxConfig(resourceKey, mounts),
      env: injection.env,
      mounts,
    };
  }

  private ensureDefaultSharedVault(
    credentialKey: string,
    legacyCredentialKey: string | undefined,
    trustModel: ActorContext["trustModel"],
  ): void {
    if (
      !allowsAmbientDefaultSharedVault({
        trustModel,
        ambientSharedVault: getSandboxAdapter(this.baseConfig.type).vault.ambientSharedVault,
      })
    ) {
      return;
    }
    if (
      this.vaultManager.hasEntry(credentialKey) ||
      (legacyCredentialKey && this.vaultManager.hasEntry(legacyCredentialKey))
    ) {
      return;
    }

    let profile: string | undefined;
    try {
      profile = loadGlobalSettings().sandbox?.defaultSharedVault;
    } catch {
      return;
    }
    if (!profile || normalizeSharedVaultName(profile) !== profile) return;
    this.vaultManager.copySharedVaultTo(profile, credentialKey);
  }

  private resolveSandboxConfig(resourceKey: string, mounts: ContainerMount[]): SandboxConfig {
    const adapter = getSandboxAdapter(this.baseConfig.type);
    return (
      adapter.resolveRuntimeConfig?.(this.baseConfig, {
        resourceKey,
        workspaceRoot: this.workspace.root,
        mounts,
      }) ?? this.baseConfig
    );
  }

  private buildEnsureReadyCallback(
    plan: ExecutionPlan,
    conversationId: string,
  ): (() => Promise<void>) | undefined {
    const adapter = getSandboxAdapter(this.baseConfig.type);
    return adapter.createEnsureReady?.(this.baseConfig, {
      provisioner: this.provisioner,
      resourceKey: plan.resourceKey,
      credentialKey: plan.credentialKey,
      mounts: plan.mounts,
      conversationId,
      hasVault: Boolean(plan.env || plan.mounts.length > 0),
    });
  }

  private resolveMounts(
    office: Office,
    vaultMounts: ContainerMount[],
    projection: ReturnType<typeof resolveWorkspaceProjection>,
  ): ContainerMount[] {
    const workspaceMounts = projection.mounts;
    // Package skills mount outside /workspace, so they cannot collide with the
    // workspace projection; they are still checked against vault mounts below,
    // which are administrator-chosen targets and could be aimed anywhere.
    const packageMounts = conversationPackageSkillMounts({ office });
    const protectedMounts = [...workspaceMounts, ...packageMounts];
    for (let index = 0; index < vaultMounts.length; index += 1) {
      const vaultMount = vaultMounts[index];
      if (vaultMount === undefined) continue;
      const workspaceCollision = protectedMounts.find((protectedMount) =>
        targetsOverlap(protectedMount.target, vaultMount.target),
      );
      if (workspaceCollision) {
        throw new Error(
          `Vault mount target "${vaultMount.target}" overlaps protected workspace target "${workspaceCollision.target}"`,
        );
      }

      const vaultCollision = vaultMounts
        .slice(0, index)
        .find((other) => targetsOverlap(other.target, vaultMount.target));
      if (vaultCollision) {
        throw new Error(
          `Vault mount target "${vaultMount.target}" overlaps vault target "${vaultCollision.target}"`,
        );
      }
    }
    return [...protectedMounts, ...vaultMounts];
  }
}

function targetsOverlap(left: string, right: string): boolean {
  const a = normalizeMountTarget(left);
  const b = normalizeMountTarget(right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function normalizeMountTarget(value: string): string {
  const normalized = posix.normalize(value);
  return normalized.replace(/\/+$/, "") || "/";
}
