import { join, posix } from "node:path";
import { effectiveStateDir } from "./cli/arg-grammar.js";
import { conversationPackageSkillMounts } from "./packages/index.js";
import { loadGlobalSettings } from "./config.js";
import { DockerContainerManager, type ContainerMount } from "./provisioner.js";
import {
  createExecutor,
  getSandboxCredentialCapabilities,
  type Executor,
  type SandboxConfig,
} from "./sandbox/index.js";
import { reportUserFacingError } from "./observability/sentry.js";
import { normalizeSharedVaultName, type VaultManager } from "./vault/index.js";
import { resolveVaultInjection } from "./vault/injection.js";
import { allowsAmbientDefaultSharedVault } from "./vault/policy.js";
import {
  credentialAuthorizationKey,
  legacyExactCredentialAuthorizationKey,
  runtimeResourceKey,
} from "./sandbox/identity.js";
import {
  resolveWorkspaceProjection,
  readWorkspaceProjectionMode,
} from "./workspace-projection/index.js";

export type { ActorContext } from "./types.js";
import type { ActorContext, ExecutionPlan } from "./types.js";

export const readConversationWorkspaceMountMode = readWorkspaceProjectionMode;

export class ActorExecutionResolver {
  constructor(
    private baseConfig: SandboxConfig,
    private vaultManager: VaultManager,
    private provisioner?: DockerContainerManager,
    private workspaceDir?: string,
    private hostWorkspacePath?: string,
  ) {}

  async resolve(context: ActorContext): Promise<Executor> {
    const plan = this.resolvePlan(context);
    return createExecutor(
      plan.sandboxConfig,
      plan.env,
      this.buildEnsureReadyCallback(plan, context.conversationId),
    );
  }

  private resolvePlan(context: ActorContext): ExecutionPlan {
    const ids = { userId: context.userId, conversationId: context.conversationId };
    const credentialKey = credentialAuthorizationKey(this.baseConfig, ids);
    const legacyCredentialKey = legacyExactCredentialAuthorizationKey(this.baseConfig, ids);
    const resourceKey = runtimeResourceKey(this.baseConfig, ids);
    this.ensureDefaultSharedVault(credentialKey, legacyCredentialKey, context.trustModel);

    const vault =
      this.vaultManager.resolve(credentialKey) ??
      (legacyCredentialKey ? this.vaultManager.resolve(legacyCredentialKey) : undefined);
    const capabilities = getSandboxCredentialCapabilities(this.baseConfig.type);
    const injection = resolveVaultInjection({
      vault,
      capabilities,
      sandboxType: this.baseConfig.type,
      conversationId: context.conversationId,
    });
    const mounts = this.resolveMounts(context.conversationId, injection.mounts);
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
    if (!allowsAmbientDefaultSharedVault({ trustModel, sandboxType: this.baseConfig.type })) return;
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
    if (this.baseConfig.type === "gondolin") {
      return {
        ...this.baseConfig,
        workspacePath: this.hostWorkspacePath,
        mounts,
        instanceId: resourceKey,
        resourceKey,
      };
    }
    if (this.baseConfig.type !== "image") return this.baseConfig;
    return {
      type: "container",
      container: DockerContainerManager.containerName(resourceKey),
    };
  }

  private buildEnsureReadyCallback(
    plan: ExecutionPlan,
    conversationId: string,
  ): (() => Promise<void>) | undefined {
    if (this.baseConfig.type !== "image" || plan.sandboxConfig.type !== "container") {
      return undefined;
    }

    return async () => {
      const expected = plan.sandboxConfig.type === "container" ? plan.sandboxConfig.container : "";
      let actual: string | undefined;
      try {
        actual = await this.provisioner?.provision(plan.resourceKey, {
          containerName: expected,
          mounts: plan.mounts,
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
            conversationId,
            credentialKey: plan.credentialKey,
            resourceKey: plan.resourceKey,
            expectedContainer: expected,
            hasVault: Boolean(plan.env || plan.mounts.length > 0),
          },
        });
        throw err;
      }
      if (actual && actual !== expected) {
        throw new Error(
          `Provisioner returned container "${actual}" for resource key "${plan.resourceKey}", expected "${expected}"`,
        );
      }
    };
  }

  private resolveMounts(conversationId: string, vaultMounts: ContainerMount[]): ContainerMount[] {
    const workspaceMounts = resolveWorkspaceProjection(this.workspaceDir, conversationId).mounts;
    // Package skills mount outside /workspace, so they cannot collide with the
    // workspace projection; they are still checked against vault mounts below,
    // which are administrator-chosen targets and could be aimed anywhere.
    const packageMounts = this.workspaceDir
      ? conversationPackageSkillMounts({
          conversationId,
          stateDir: effectiveStateDir(),
          conversationDir: join(this.workspaceDir, conversationId),
        })
      : [];
    const protectedMounts = [...workspaceMounts, ...packageMounts];
    for (let index = 0; index < vaultMounts.length; index += 1) {
      const vaultMount = vaultMounts[index];
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
