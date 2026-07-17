import type { MessagingBot, PlatformName, RunningSession } from "../../adapter.js";
import type { LinkTokenStoreLike } from "../../commands/types.js";
import type { SandboxConfig } from "../../sandbox/index.js";
import type { EventStore } from "../../tools/types.js";
import type { VaultManager } from "../../vault/index.js";
import type { InMemorySessionViewTokenStore } from "../session-view/store.js";
import type { TokenRecord } from "../types.js";
import type { InMemoryAdminTokenStore } from "./store.js";

export interface AdminRuntimeBridge {
  getRunningSessions(): RunningSession[];
  switchConversationModel(conversationId: string, provider: string, model: string): boolean;
  refreshAllConversations(): { busy: string[] };
}

export interface AdminServices {
  vaultManager: VaultManager;
  linkTokenStore: LinkTokenStoreLike;
  sessionViewTokenStore?: InMemorySessionViewTokenStore;
  adminTokenStore: InMemoryAdminTokenStore;
  portalBaseUrl?: string;
  workingDir?: string;
  /** Events read/delete go through the owning store, not raw disk parsing. */
  eventStore?: EventStore;
  sandbox?: SandboxConfig;
  runtime?: AdminRuntimeBridge;
  botsByPlatform?: Partial<Record<PlatformName, MessagingBot>>;
}

export interface AdminToken extends TokenRecord {
  platform: PlatformName;
  platformUserId: string;
  platformUserName?: string;
  /** The conversation where /admin was invoked. Default scope for the 3 sub-pages. */
  conversationId: string;
}
