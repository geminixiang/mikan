import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { MessagingBot, PlatformName } from "../adapter.js";
import { resolveLinkBaseUrl } from "../config.js";
import * as log from "../log.js";
import type { SandboxConfig } from "../sandbox/index.js";
import { HostEventStore } from "../tools/event.js";
import type { VaultManager } from "../vault/index.js";
import { handleAdminRequest, type AdminRuntimeBridge } from "./admin/portal.js";
import type { InMemoryAdminTokenStore } from "./admin/store.js";
import { handleAgentEventsRequest } from "../agent-events.js";
import type { ConnectorGateway } from "../connector/gateway.js";
import { createConnectorRequestHandler } from "./login/connector-portal.js";
import { createLoginRequestHandler } from "./login/portal.js";
import { requestBaseUrl } from "./portal-shell.js";
import type { InMemoryLinkTokenStore } from "./login/store.js";
import type { NotifyFn } from "./login/types.js";
import { handleWebAuthRequest, type WebAuthRequestOptions } from "./auth/portal.js";
import { handleWebAppRequest, type WebAppRequestOptions } from "./app/portal.js";
import { handleWebHarnessRequest, type WebHarnessRequestOptions } from "./harness/portal.js";
import {
  handleSessionViewRequest,
  type SessionViewInteractiveOptions,
} from "./session-view/portal.js";
import type { InMemorySessionViewTokenStore } from "./session-view/store.js";
import type { Workspace } from "../office/types.js";
import {
  handleGithubWebhookRequest,
  type GithubWebhookOptions,
} from "../adapters/github/webhook.js";

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
  };
  githubWebhook?: GithubWebhookOptions;
  webAuth?: WebAuthRequestOptions;
  connector?: ConnectorGateway;
  webHarness?: WebHarnessRequestOptions;
  webApp?: WebAppRequestOptions;
}

export function startWebServer(options: StartWebServerOptions): Server {
  const loginHandler = createLoginRequestHandler(
    options.linkTokenStore,
    options.vaultManager,
    options.notify,
    { connectorEnabled: Boolean(options.connector) },
  );
  const connectorHandler = options.connector
    ? createConnectorRequestHandler(options.connector, options.linkTokenStore, options.notify)
    : undefined;

  // Constructed once at server start; the admin portal consumes the owning
  // event store's interface instead of re-parsing event files off disk.
  const adminEventStore = options.adminOptions?.workspace
    ? HostEventStore.fromWorkspaceDir(options.adminOptions.workspace.root)
    : undefined;

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

      if (handleAgentEventsRequest(req, res, url)) return;

      if (
        options.webHarness &&
        (await handleWebHarnessRequest(req, res, url, options.webHarness))
      ) {
        return;
      }

      if (options.webAuth && (await handleWebAuthRequest(req, res, url, options.webAuth))) {
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

      if (connectorHandler?.(req, res, url)) return;

      if (loginHandler(req, res, url)) return;

      if (options.webApp && handleWebAppRequest(req, res, url, options.webApp)) return;

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
