import { posix } from "node:path";

import { loadGlobalSettings } from "../settings/index.js";
import { DockerContainerManager } from "../sandbox/provisioner.js";
import type { ContainerMount, ActorContext, ExecutionPlan } from "../types.js";
import { createContainerExecutionEnv } from "../sandbox/container.js";
import { getSandboxPathContext } from "../sandbox/registry.js";
import { reportUserFacingError } from "../observability/index.js";
import { normalizeSharedVaultName } from "../vault/index.js";
import type { VaultManager } from "../vault/types.js";
import { allowsAmbientDefaultSharedVault, resolveVaultInjection } from "../vault/index.js";
import { officeKey } from "../office/index.js";
import { resolveWorkspaceProjection } from "../office/projection.js";
import type { WorkspaceProjection, Workspace } from "../office/types.js";

export class ActorExecutionResolver {
  constructor(
    private vaultManager: Pick<VaultManager, "hasEntry" | "resolve" | "copySharedVaultTo">,
    private provisioner: Pick<DockerContainerManager, "provision" | "markUsed"> | undefined,
    private workspace: Workspace,
  ) {}

  async resolve(context: ActorContext) {
    const { plan, projection } = this.resolvePlan(context);
    const pathContext = getSandboxPathContext(this.workspace.root);
    const env = createContainerExecutionEnv({
      container: plan.container,
      cwd: posix.join(pathContext.runtimeWorkspaceRoot, officeKey(context.address)),
      env: plan.env,
      ensureReady: this.buildEnsureReadyCallback(plan, context.address.conversationId),
      markUsed: () => this.provisioner?.markUsed(plan.resourceKey),
    });
    return { env, pathContext, projection };
  }

  async prepare(context: ActorContext): Promise<string> {
    const { plan } = this.resolvePlan(context);
    await this.buildEnsureReadyCallback(plan, context.address.conversationId)();
    return plan.resourceKey;
  }

  private resolvePlan(context: ActorContext): {
    plan: ExecutionPlan;
    projection: WorkspaceProjection;
  } {
    const credentialKey = officeKey(context.address);
    const resourceKey = credentialKey;
    this.ensureDefaultSharedVault(credentialKey, context.trustModel);

    const vault = this.vaultManager.resolve(credentialKey);
    const office = this.workspace.office(context.address);
    const projection = resolveWorkspaceProjection(office);
    const injection = resolveVaultInjection(vault, office.address);
    const mounts = this.resolveMounts(injection.mounts, projection);
    return {
      plan: {
        credentialKey,
        resourceKey,
        container: DockerContainerManager.containerName(resourceKey),
        env: injection.env,
        mounts,
      },
      projection,
    };
  }

  private ensureDefaultSharedVault(
    credentialKey: string,
    trustModel: ActorContext["trustModel"],
  ): void {
    if (!allowsAmbientDefaultSharedVault(trustModel)) return;
    if (this.vaultManager.hasEntry(credentialKey)) return;

    let profile: string | undefined;
    try {
      profile = loadGlobalSettings(this.workspace.stateDir).sandbox?.defaultSharedVault;
    } catch {
      return;
    }
    if (!profile || normalizeSharedVaultName(profile) !== profile) return;
    this.vaultManager.copySharedVaultTo(profile, credentialKey);
  }

  private buildEnsureReadyCallback(
    plan: ExecutionPlan,
    conversationId: string,
  ): () => Promise<void> {
    return async () => {
      try {
        await this.provisioner?.provision(plan.resourceKey, {
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
            sandboxType: "oci",
            conversationId,
            credentialKey: plan.credentialKey,
            resourceKey: plan.resourceKey,
            expectedContainer: plan.container,
            hasVault: Boolean(plan.env || plan.mounts.length > 0),
          },
        });
        throw err;
      }
    };
  }

  private resolveMounts(
    vaultMounts: ContainerMount[],
    projection: WorkspaceProjection,
  ): ContainerMount[] {
    const protectedMounts = projection.mounts;
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
