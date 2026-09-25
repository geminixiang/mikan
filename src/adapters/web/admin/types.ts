import type { MessagingBot, OfficeAddress, PlatformName, RunningSession } from "../../index.js";
import type { Office, Workspace } from "../../../office/index.js";
import type { LinkTokenStoreLike } from "../../commands/types.js";
import type { SandboxConfig } from "../../../sandbox/index.js";
import type { EventStore } from "../../../events/index.js";
import type { VaultManager } from "../../../vault/index.js";
import type { InMemorySessionViewTokenStore } from "../session-view/portal.js";
import type { TokenRecord } from "../types.js";
import type { InMemoryAdminTokenStore } from "./portal.js";

export interface AdminRuntimeBridge {
  getRunningSessions(): RunningSession[];
  switchConversationModel(address: OfficeAddress, provider: string, model: string): boolean;
  refreshConversationEnvironment(address: OfficeAddress): boolean;
  refreshAllConversations(): { busy: OfficeAddress[] };
}

export interface AdminServices {
  vaultManager: VaultManager;
  linkTokenStore: LinkTokenStoreLike;
  sessionViewTokenStore?: InMemorySessionViewTokenStore;
  adminTokenStore: InMemoryAdminTokenStore;
  portalBaseUrl?: string;
  workspace?: Workspace;
  eventStore?: (office: Office) => EventStore;
  sandbox?: SandboxConfig;
  runtime?: AdminRuntimeBridge;
  botsByPlatform?: Partial<Record<PlatformName, MessagingBot>>;
}

export interface EventSummary {
  name: string;
  size: number;
  mtimeMs: number;
  type: string | null;
  officePlatform: string;
  officeConversationId: string;
  platform: string | null;
  conversationId: string | null;
  text: string | null;
  at: string | null;
  schedule: string | null;
  timezone: string | null;
}

export interface AdminTokenCreateOptions {
  platform: PlatformName;
  platformUserId: string;
  conversationId: string;
  platformUserName?: string;
}

export interface AdminToken extends TokenRecord {
  platform: PlatformName;
  platformUserId: string;
  platformUserName?: string;
  conversationId: string;
}
