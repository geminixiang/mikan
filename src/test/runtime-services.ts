import { InMemoryAdminTokenStore } from "../adapters/web/admin/portal.js";
import { InMemoryLinkTokenStore } from "../adapters/web/login/portal.js";
import { InMemorySessionViewTokenStore } from "../adapters/web/session-view/portal.js";
import { FileVaultManager } from "../vault/index.js";

export function runtimeServices(stateDir: string) {
  return {
    vaultManager: new FileVaultManager(stateDir),
    linkTokenStore: new InMemoryLinkTokenStore(),
    sessionViewTokenStore: new InMemorySessionViewTokenStore(),
    adminTokenStore: new InMemoryAdminTokenStore(),
  };
}
