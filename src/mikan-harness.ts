/**
 * MikanHarness — composition root for session/sandbox/vault/agent-run setup.
 *
 * This is NOT part of src/harness/: that directory is deliberately scoped to
 * LLM/session primitives with no knowledge of vault or sandbox provisioning
 * (see the review that led to this class). MikanHarness sits one layer above
 * both src/harness/ and src/vault/, src/sandbox/, src/provisioner.ts — it
 * only assembles them, so a caller (main.ts, a future adapter, a test
 * harness) doesn't have to re-copy that assembly by hand.
 */
import { writeFileSync } from "fs";
import { join } from "path";
import type { CommandHandler } from "./commands/types.js";
import { loadGlobalSettings } from "./config.js";
import { DockerContainerManager } from "./provisioner.js";
import { createConversationRuntime } from "./runtime/conversation-runtime.js";
import type { ConversationRuntime } from "./runtime/types.js";
import { type SandboxConfig, validateSandbox } from "./sandbox/index.js";
import { ensureDirExists } from "./utils/file-guards.js";
import { FileVaultManager, type VaultManager } from "./vault/index.js";
import { InMemoryAdminTokenStore } from "./web/admin/store.js";
import { InMemoryLinkTokenStore } from "./web/login/store.js";
import { InMemorySessionViewTokenStore } from "./web/session-view/store.js";

/** Idle timeout for managed image containers (10 minutes). */
const DEFAULT_IMAGE_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
/** How often in-memory token stores drop expired entries. */
const DEFAULT_TOKEN_PURGE_INTERVAL_MS = 5 * 60 * 1000;

export interface MikanHarnessOptions {
  workingDir: string;
  stateDir: string;
  sandbox: SandboxConfig;
  portalBaseUrl?: string;
  commandHandlers?: readonly CommandHandler[];
  imageIdleTimeoutMs?: number;
  tokenPurgeIntervalMs?: number;
}

export class MikanHarness {
  private constructor(
    readonly runtime: ConversationRuntime,
    readonly vaultManager: VaultManager,
    readonly provisioner: DockerContainerManager | undefined,
    readonly linkTokenStore: InMemoryLinkTokenStore,
    readonly sessionViewTokenStore: InMemorySessionViewTokenStore,
    readonly adminTokenStore: InMemoryAdminTokenStore,
  ) {}

  static async create(options: MikanHarnessOptions): Promise<MikanHarness> {
    const { workingDir, stateDir, sandbox } = options;
    const imageIdleTimeoutMs = options.imageIdleTimeoutMs ?? DEFAULT_IMAGE_IDLE_TIMEOUT_MS;
    const tokenPurgeIntervalMs = options.tokenPurgeIntervalMs ?? DEFAULT_TOKEN_PURGE_INTERVAL_MS;

    await validateSandbox(sandbox);

    const vaultManager = new FileVaultManager(stateDir);
    logVaultStatus(vaultManager, sandbox);

    const startupConfig = loadGlobalSettings();
    const sandboxLimits =
      startupConfig.sandboxCpus || startupConfig.sandboxMemory
        ? { cpus: startupConfig.sandboxCpus, memory: startupConfig.sandboxMemory }
        : undefined;
    const sandboxBoostLimits =
      startupConfig.sandboxBoostCpus || startupConfig.sandboxBoostMemory
        ? { cpus: startupConfig.sandboxBoostCpus, memory: startupConfig.sandboxBoostMemory }
        : undefined;

    const provisioner =
      sandbox.type === "image"
        ? new DockerContainerManager(sandbox.image, {
            limits: sandboxLimits,
            boostLimits: sandboxBoostLimits,
          })
        : undefined;

    if (sandbox.type === "image") {
      ensureDirExists(join(workingDir, "skills"));
      ensureDirExists(join(workingDir, "events"));
      try {
        writeFileSync(join(workingDir, "MEMORY.md"), "", { flag: "wx" });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }

    const linkTokenStore = new InMemoryLinkTokenStore();
    const sessionViewTokenStore = new InMemorySessionViewTokenStore();
    const adminTokenStore = new InMemoryAdminTokenStore();
    setInterval(() => linkTokenStore.purge(), tokenPurgeIntervalMs).unref();
    setInterval(() => sessionViewTokenStore.purge(), tokenPurgeIntervalMs).unref();
    setInterval(() => adminTokenStore.purge(), tokenPurgeIntervalMs).unref();

    if (provisioner) {
      await provisioner.reconcile();
      await provisioner.stopIdle(imageIdleTimeoutMs);
      setInterval(() => provisioner.stopIdle(imageIdleTimeoutMs), imageIdleTimeoutMs).unref();
    }

    const runtime = createConversationRuntime({
      workingDir,
      sandbox,
      vaultManager,
      provisioner,
      linkTokenStore,
      sessionViewTokenStore,
      adminTokenStore,
      portalBaseUrl: options.portalBaseUrl,
      commandHandlers: options.commandHandlers,
    });

    return new MikanHarness(
      runtime,
      vaultManager,
      provisioner,
      linkTokenStore,
      sessionViewTokenStore,
      adminTokenStore,
    );
  }

  async shutdown(): Promise<void> {
    return this.runtime.shutdown();
  }
}

function logVaultStatus(vaultManager: VaultManager, sandbox: SandboxConfig): void {
  if (!vaultManager.isEnabled()) return;
  console.log(
    sandbox.type === "container"
      ? "  Vault system enabled. Container vault active."
      : sandbox.type === "image" || sandbox.type === "firecracker" || sandbox.type === "cloudflare"
        ? "  Vault system enabled. Conversation-scoped credential routing active."
        : "  Vault system enabled. Host mode will not inject vault env.",
  );
}
