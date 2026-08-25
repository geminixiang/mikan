import { existsSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { WebServer, registerStaticFallback } from "@geminixiang/mikan-web-host";
import type { MessagingBot, PlatformName } from "../adapter.js";
import {
  GITHUB_WEBHOOK_PATH,
  handleGithubWebhookRequest,
  type GithubWebhookOptions,
} from "../adapters/github/webhook.js";
import { handleAgentEventsRequest } from "../agent-events.js";
import { resolveLinkBaseUrl } from "../config.js";
import * as log from "../log.js";
import type { Workspace } from "../office/types.js";
import type { SandboxConfig } from "../sandbox/index.js";
import { HostEventStore } from "../tools/event.js";
import type { VaultManager } from "../vault/index.js";
import { handleAdminRequest, type AdminRuntimeBridge } from "./admin/portal.js";
import type { InMemoryAdminTokenStore } from "./admin/store.js";
import { createHarnessRequestHandler } from "./harness/http.js";
import type { HarnessHost } from "./harness/types.js";
import { createBindingHandler } from "./login/binding-handler.js";
import type { WebBindingStore } from "./login/binding.js";
import { createLoginRequestHandler } from "./login/portal.js";
import type { InMemoryWebSessionStore } from "./login/session-store.js";
import type { InMemoryLinkTokenStore } from "./login/store.js";
import type { NotifyFn } from "./login/types.js";
import { requestBaseUrl } from "./portal-shell.js";
import {
  handleSessionViewRequest,
  type SessionViewInteractiveOptions,
} from "./session-view/portal.js";
import type { InMemorySessionViewTokenStore } from "./session-view/store.js";

interface StartWebServerOptions {
  port: number;
  linkTokenStore: InMemoryLinkTokenStore;
  vaultManager: VaultManager;
  notify: NotifyFn;
  sessionViewTokenStore?: InMemorySessionViewTokenStore;
  sessionViewInteractive?: SessionViewInteractiveOptions;
  bindingTokenStore?: WebBindingStore;
  webSessionStore?: InMemoryWebSessionStore;
  harnessHost?: HarnessHost;
  adminOptions?: {
    adminTokenStore: InMemoryAdminTokenStore;
    workspace?: Workspace;
    runtime?: AdminRuntimeBridge;
    sandbox?: SandboxConfig;
    botsByPlatform?: Partial<Record<PlatformName, MessagingBot>>;
  };
  githubWebhook?: GithubWebhookOptions;
  /** Absolute path of the built Web Harness Client index.html. */
  webDistIndex?: string;
}

function requestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", requestBaseUrl(req));
}

function bindHostOf(): string | undefined {
  return resolveLinkBaseUrl() ? undefined : "127.0.0.1";
}

function registerCoreRoutes(webServer: WebServer, options: StartWebServerOptions): void {
  webServer.register({
    kind: "exact",
    path: "/health",
    handler: (req, res) => {
      if (req.method !== "GET") return false;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return true;
    },
  });

  if (options.githubWebhook) {
    const githubWebhook = options.githubWebhook;
    webServer.register({
      kind: "exact",
      path: GITHUB_WEBHOOK_PATH,
      handler: (req, res) => handleGithubWebhookRequest(req, res, requestUrl(req), githubWebhook),
    });
  }

  webServer.register({
    kind: "exact",
    path: "/api/agent-events/stream",
    handler: (req, res) => handleAgentEventsRequest(req, res, requestUrl(req)),
  });
}

function registerHarnessRoutes(webServer: WebServer, options: StartWebServerOptions): void {
  if (!options.harnessHost || !options.webSessionStore) return;
  const handler = createHarnessRequestHandler(options.harnessHost, options.webSessionStore);
  webServer.register({
    kind: "prefix",
    path: "/api/harness",
    handler: (req, res) => handler(req, res, requestUrl(req)),
  });
}

function registerAdminRoutes(
  webServer: WebServer,
  options: StartWebServerOptions,
  eventStore: ReturnType<typeof HostEventStore.fromWorkspaceDir> | undefined,
): void {
  const adminOptions = options.adminOptions;
  if (!adminOptions?.adminTokenStore) {
    webServer.register({
      kind: "prefix",
      path: "/admin",
      handler: (_req, res) => {
        writeNotFound(res);
        return true;
      },
    });
    return;
  }
  webServer.register({
    kind: "prefix",
    path: "/admin",
    handler: async (req, res) => {
      const handled = await handleAdminRequest(req, res, requestUrl(req), {
        vaultManager: options.vaultManager,
        linkTokenStore: options.linkTokenStore,
        sessionViewTokenStore: options.sessionViewTokenStore,
        adminTokenStore: adminOptions.adminTokenStore,
        portalBaseUrl: resolveLinkBaseUrl() ?? undefined,
        workspace: adminOptions.workspace,
        eventStore,
        runtime: adminOptions.runtime,
        sandbox: adminOptions.sandbox,
        botsByPlatform: adminOptions.botsByPlatform,
      });
      if (handled === false) writeNotFound(res);
      return true;
    },
  });
}

function registerSessionRoutes(webServer: WebServer, options: StartWebServerOptions): void {
  webServer.register({
    kind: "prefix",
    path: "/session",
    handler: async (req, res) => {
      const handled = await handleSessionViewRequest(
        req,
        res,
        requestUrl(req),
        options.sessionViewTokenStore,
        options.sessionViewInteractive,
      );
      if (handled === false) writeNotFound(res);
      return true;
    },
  });
}

function registerLoginRoutes(
  webServer: WebServer,
  loginHandler: (req: IncomingMessage, res: ServerResponse, url: URL) => boolean,
): void {
  for (const path of [
    "/link",
    "/api/link/info",
    "/api/link/complete",
    "/api/oauth/start",
    "/api/me",
    "/api/logout",
    "/oauth/callback",
  ]) {
    webServer.register({
      kind: "exact",
      path,
      handler: (req, res) => {
        const handled = loginHandler(req, res, requestUrl(req));
        if (handled === false) writeNotFound(res);
        return true;
      },
    });
  }
  // Unknown descendants of the credential portal are never SPA routes.
  webServer.register({
    kind: "prefix",
    path: "/link",
    handler: (_req, res) => {
      writeNotFound(res);
      return true;
    },
  });
}

function registerBindingRoutes(webServer: WebServer, store: WebBindingStore | undefined): void {
  if (!store) return;
  const handler = createBindingHandler(store);
  for (const path of ["/binding", "/api/binding/info"]) {
    webServer.register({
      kind: "exact",
      path,
      handler: (req, res) => {
        const handled = handler(req, res, requestUrl(req));
        if (handled === false) writeNotFound(res);
        return true;
      },
    });
  }
}

function registerApiGuard(webServer: WebServer): void {
  webServer.register({
    kind: "prefix",
    path: "/api",
    handler: (_req, res) => {
      res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "API endpoint not found" }));
      return true;
    },
  });
}

function registerWebAppDist(webServer: WebServer, distIndex: string): void {
  registerStaticFallback({ webServer, distIndex });
  log.logInfo(`Web Harness Client serving from ${distIndex}`);
}

function writeNotFound(res: ServerResponse): void {
  if (res.headersSent) return;
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
}

export async function startWebServer(options: StartWebServerOptions): Promise<Server | undefined> {
  const webServer = new WebServer();
  const loginHandler = createLoginRequestHandler(
    options.linkTokenStore,
    options.vaultManager,
    options.notify,
    options.bindingTokenStore,
    options.webSessionStore,
  );
  const adminEventStore = options.adminOptions?.workspace
    ? HostEventStore.fromWorkspaceDir(options.adminOptions.workspace.root)
    : undefined;

  registerCoreRoutes(webServer, options);
  registerHarnessRoutes(webServer, options);
  registerAdminRoutes(webServer, options, adminEventStore);
  registerSessionRoutes(webServer, options);
  registerLoginRoutes(webServer, loginHandler);
  registerBindingRoutes(webServer, options.bindingTokenStore);
  registerApiGuard(webServer);

  const webDistIndex = options.webDistIndex;
  if (webDistIndex && existsSync(webDistIndex)) registerWebAppDist(webServer, webDistIndex);

  const bindHost = bindHostOf();
  let server: Server;
  try {
    server = await webServer.listen({
      port: options.port,
      host: bindHost,
      onRequestError: (req, error) => {
        log.logWarning(
          "Web server request error",
          error instanceof Error ? error.message : String(error),
        );
        void req;
      },
    });
  } catch (error) {
    log.logWarning(
      "Web server failed to start",
      error instanceof Error ? error.message : String(error),
    );
    return undefined;
  }

  log.logInfo(`Web server listening on ${bindHost ?? "0.0.0.0"}:${options.port}`);
  if (!resolveLinkBaseUrl()) {
    log.logWarning(
      "MIKAN_LINK_URL is not set — bound to 127.0.0.1 and OAuth redirect_uri will be " +
        "derived from request headers (Host / X-Forwarded-*). Set " +
        "MIKAN_LINK_URL=https://your-host.example.com for production.",
    );
  }
  server.on("error", (error) => log.logWarning("Web server error", error.message));
  return server;
}
