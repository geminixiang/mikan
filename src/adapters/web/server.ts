import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { MessagingBot, PlatformName } from "../../adapter.js";
import { resolveLinkBaseUrl } from "../../env-manifest.js";
import * as log from "../../log.js";
import type { SandboxConfig } from "../../sandbox/index.js";
import { OfficeEventStore, type EventScheduleSink } from "../../events/index.js";
import type { VaultManager } from "../../vault/index.js";
import { handleAdminRequest, type AdminRuntimeBridge } from "./admin/portal.js";
import type { InMemoryAdminTokenStore } from "./admin/portal.js";
import { createLoginRequestHandler } from "./login/portal.js";
import { requestBaseUrl } from "./portal-shell.js";
import type { InMemoryLinkTokenStore } from "./login/portal.js";
import type { NotifyFn } from "./login/types.js";
import {
  handleSessionViewRequest,
  type SessionViewInteractiveOptions,
} from "./session-view/portal.js";
import type { InMemorySessionViewTokenStore } from "./session-view/portal.js";
import type { Office, Workspace } from "../../office/types.js";
import { handleGithubWebhookRequest, type GithubWebhookOptions } from "../github/webhook.js";

interface StartWebServerOptions {
  port: number;
  linkTokenStore: InMemoryLinkTokenStore;
  vaultManager: VaultManager;
  notify: NotifyFn;
  sessionViewTokenStore?: InMemorySessionViewTokenStore;
  sessionViewInteractive?: SessionViewInteractiveOptions;
  adminOptions?: {
    adminTokenStore: InMemoryAdminTokenStore;
    workspace?: Workspace;
    runtime?: AdminRuntimeBridge;
    sandbox?: SandboxConfig;
    botsByPlatform?: Partial<Record<PlatformName, MessagingBot>>;
    /** Scheduler notified by Admin event deletes; resolved lazily (starts after bots). */
    eventScheduler?: () => EventScheduleSink | undefined;
  };
  githubWebhook?: GithubWebhookOptions;
}

export function startWebServer(options: StartWebServerOptions): Server {
  const loginHandler = createLoginRequestHandler(
    options.linkTokenStore,
    options.vaultManager,
    options.notify,
  );

  // The admin portal consumes office-confined event stores instead of
  // re-parsing event files off disk.
  const adminEventStore = (office: Office) =>
    new OfficeEventStore(office, options.adminOptions?.eventScheduler?.());

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", requestBaseUrl(req));

      if (req.method === "GET" && url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (
        options.githubWebhook &&
        (await handleGithubWebhookRequest(req, res, url, options.githubWebhook))
      ) {
        return;
      }

      const adminOptions = options.adminOptions;
      if (
        adminOptions?.adminTokenStore &&
        (await handleAdminRequest(req, res, url, {
          vaultManager: options.vaultManager,
          linkTokenStore: options.linkTokenStore,
          sessionViewTokenStore: options.sessionViewTokenStore,
          adminTokenStore: adminOptions.adminTokenStore,
          portalBaseUrl: resolveLinkBaseUrl() ?? undefined,
          workspace: adminOptions.workspace,
          eventStore: adminEventStore,
          runtime: adminOptions.runtime,
          sandbox: adminOptions.sandbox,
          botsByPlatform: adminOptions.botsByPlatform,
        }))
      ) {
        return;
      }

      if (
        await handleSessionViewRequest(
          req,
          res,
          url,
          options.sessionViewTokenStore,
          options.sessionViewInteractive,
        )
      ) {
        return;
      }

      if (loginHandler(req, res, url)) return;

      res.writeHead(404);
      res.end();
    } catch (err) {
      log.logWarning("Web server request error", err instanceof Error ? err.message : String(err));
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
      }
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  });

  const bindHost = resolveLinkBaseUrl() ? undefined : "127.0.0.1";
  server.listen(options.port, bindHost, () => {
    log.logInfo(`Web server listening on ${bindHost ?? "0.0.0.0"}:${options.port}`);
    if (!resolveLinkBaseUrl()) {
      log.logWarning(
        "MIKAN_LINK_URL is not set — bound to 127.0.0.1 and OAuth redirect_uri will be " +
          "derived from request headers (Host / X-Forwarded-*). Set " +
          "MIKAN_LINK_URL=https://your-host.example.com for production.",
      );
    }
  });

  server.on("error", (err) => {
    log.logWarning("Web server error", err.message);
  });

  return server;
}
