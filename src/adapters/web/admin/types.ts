import type {
  GlobalRunnerCacheControl,
  MessagingBot,
  PlatformName,
  RunnerCacheControl,
  RunningSession,
} from "../../../types.js";
import type { Office, Workspace } from "../../../office/types.js";
import type { LinkTokenStoreLike } from "../../commands/types.js";
import type { SandboxConfig } from "../../../sandbox/types.js";
import type { EventStore } from "../../../events/index.js";
import type { InMemorySessionViewTokenStore } from "../session-view/portal.js";
import type { TokenRecord } from "../types.js";
import type { InMemoryAdminTokenStore } from "./portal.js";

export interface AdminRuntimeBridge extends RunnerCacheControl, GlobalRunnerCacheControl {
  getRunningSessions(): RunningSession[];
}

export interface AdminServices {
  linkTokenStore: LinkTokenStoreLike;
  sessionViewTokenStore?: InMemorySessionViewTokenStore;
  adminTokenStore: InMemoryAdminTokenStore;
  portalBaseUrl?: string;
  workspace: Workspace;
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
