import type { PlatformName, RunningSession } from "../../adapter.js";
import type { TokenRecord } from "../types.js";
import type { VaultManager } from "../../vault/index.js";
import type { InMemorySessionViewTokenStore } from "../session-view/store.js";

export interface AdminRuntimeBridge {
  getRunningSessions(): RunningSession[];
  switchConversationModel(conversationId: string, provider: string, model: string): boolean;
}

export interface AdminServices {
  vaultManager: VaultManager;
  linkTokenStore: {
    create(
      platform: PlatformName,
      platformUserId: string,
      conversationId: string,
      vaultId: string,
      providerId: string,
    ): { token: string };
  };
  sessionViewTokenStore?: InMemorySessionViewTokenStore;
  adminTokenStore: import("./store.js").InMemoryAdminTokenStore;
  portalBaseUrl?: string;
  workingDir?: string;
  sandbox?: import("../../sandbox/index.js").SandboxConfig;
  runtime?: AdminRuntimeBridge;
  botsByPlatform?: Partial<Record<PlatformName, import("../../adapter.js").Bot>>;
}

export interface AdminToken extends TokenRecord {
  platform: PlatformName;
  platformUserId: string;
  platformUserName?: string;
  /** The conversation where /admin was invoked. Default scope for the 3 sub-pages. */
  conversationId: string;
}
