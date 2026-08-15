import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { MessagingBot, PlatformName } from "../adapter.js";
import { resolveLinkBaseUrl } from "../config.js";
import * as log from "../log.js";
import type { SandboxConfig } from "../sandbox/index.js";
import { HostEventStore } from "../tools/event.js";
import type { VaultManager } from "../vault/index.js";
import { handleAdminRequest, type AdminRuntimeBridge } from "./admin/portal.js";
import type { InMemoryAdminTokenStore } from "./admin/store.js";
import { handleAgentEventsRequest } from "../agent-events.js";
import { createLoginRequestHandler } from "./login/portal.js";
import { createBindingHandler } from "./login/binding-handler.js";
import { requestBaseUrl } from "./portal-shell.js";
import type { InMemoryLinkTokenStore } from "./login/store.js";
import type { InMemoryBindingTokenStore } from "./login/binding.js";
import type { NotifyFn } from "./login/types.js";
import {
  handleSessionViewRequest,
  type SessionViewInteractiveOptions,
} from "./session-view/portal.js";
import { handleSessionViewApiRequest } from "./session-view/api.js";
import type { InMemorySessionViewTokenStore } from "./session-view/store.js";
import type { Workspace } from "../office/types.js";
import {
  handleGithubWebhookRequest,
  GITHUB_WEBHOOK_PATH,
  type GithubWebhookOptions,
} from "../adapters/github/webhook.js";
import { existsSync } from "node:fs";
import { WebServer, registerStaticFallback, injectBootManifest } from "@geminixiang/mikan-web-host";
import { composeWebBootGraph, contentRev, entryUrlOfIndex } from "@geminixiang/mikan-web-bundle";

interface StartWebServerOptions {
  port: number;
  linkTokenStore: InMemoryLinkTokenStore;
  vaultManager: VaultManager;
  notify: NotifyFn;
  sessionViewTokenStore?: InMemorySessionViewTokenStore;
  sessionViewInteractive?: SessionViewInteractiveOptions;
  bindingTokenStore?: InMemoryBindingTokenStore;
  adminOptions?: {
    adminTokenStore: InMemoryAdminTokenStore;
    workspace?: Workspace;
    runtime?: AdminRuntimeBridge;
    sandbox?: SandboxConfig;
    botsByPlatform?: Partial<Record<PlatformName, MessagingBot>>;
  };
  githubWebhook?: GithubWebhookOptions;
  /**
   * Absolute path of the built web app's index.html (e.g. apps/web/dist).
   * When set and the file exists, the static-dist fallback seat is claimed and
   * `window.__MIKAN_BOOT__` is injected into every index response. Omit to keep
   * the previous 404-on-unmatched behavior.
   */
  webDistIndex?: string;
}

/** Build the request URL exactly as the previous monolithic dispatch did. */
function requestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", requestBaseUrl(req));
}

/** Bind host: 0.0.0.0 when a link base URL is configured, else loopback. */
function bindHostOf(): string | undefined {
  return resolveLinkBaseUrl() ? undefined : "127.0.0.1";
}

// ── Route registration helpers (DSH webServer pattern) ──────────────────────
// Each handler keeps the boolean "handled? / not mine" contract, so a decline
// falls through to the next candidate exactly as the old if-chain.

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

  const githubWebhook = options.githubWebhook;
  if (githubWebhook) {
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

  webServer.register({
    kind: "exact",
    path: "/api/session/view",
    handler: (req, res) =>
      handleSessionViewApiRequest(
        req,
        res,
        requestUrl(req),
        options.sessionViewTokenStore,
        options.sessionViewInteractive,
      ),
  });
}

function registerAdminRoutes(
  webServer: WebServer,
  options: StartWebServerOptions,
  adminEventStore: ReturnType<typeof HostEventStore.fromWorkspaceDir> | undefined,
  distActive: boolean,
): void {
  const adminOptions = options.adminOptions;
  if (!adminOptions?.adminTokenStore) return;
  webServer.register({
    kind: "prefix",
    path: "/admin",
    handler: (req, res) => {
      const url = requestUrl(req);
      // When the SPA is served, the admin page route belongs to the SPA
      // (same URL); all /admin/api/* routes below stay with the daemon.
      if (distActive && req.method === "GET" && url.pathname === "/admin") return false;
      return handleAdminRequest(req, res, url, {
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
      });
    },
  });
}

function registerSessionRoutes(
  webServer: WebServer,
  options: StartWebServerOptions,
  distActive: boolean,
): void {
  webServer.register({
    kind: "prefix",
    path: "/session",
    handler: (req, res) => {
      const url = requestUrl(req);
      // The session *page* is the SPA's when the dist is served; the stream
      // and message routes below stay with the daemon (the SPA uses them).
      if (distActive && req.method === "GET" && url.pathname === "/session") return false;
      return handleSessionViewRequest(
        req,
        res,
        url,
        options.sessionViewTokenStore,
        options.sessionViewInteractive,
      );
    },
  });
}

function registerLoginRoutes(
  webServer: WebServer,
  loginHandler: (req: IncomingMessage, res: ServerResponse, url: URL) => boolean,
  distActive: boolean,
): void {
  for (const path of [
    "/link",
    "/api/link/info",
    "/api/link/complete",
    "/api/oauth/start",
    "/oauth/callback",
  ]) {
    webServer.register({
      kind: "exact",
      path,
      handler: (req, res) => {
        const url = requestUrl(req);
        // The vault/link *page* is the SPA's when the dist is served; the
        // completion and OAuth API routes stay with the daemon.
        if (distActive && path === "/link" && req.method === "GET") return false;
        return loginHandler(req, res, url);
      },
    });
  }
}

/** Claim the fallback seat over the built dist and inject the boot manifest. */
function registerWebAppDist(webServer: WebServer, distIndex: string): void {
  registerStaticFallback({ webServer, distIndex });
  webServer.tapIndex((html) => {
    const entryUrl = entryUrlOfIndex(html) ?? "/";
    const graph = composeWebBootGraph({ entryUrl, entryRev: contentRev(html) });
    return injectBootManifest(html, graph);
  });
  log.logInfo(`Web app dist serving from ${distIndex}`);
}

export async function startWebServer(options: StartWebServerOptions): Promise<Server | undefined> {
  const webServer = new WebServer();

  const loginHandler = createLoginRequestHandler(
    options.linkTokenStore,
    options.vaultManager,
    options.notify,
    options.bindingTokenStore,
  );

  // Constructed once at server start; the admin portal consumes the owning
  // event store's interface instead of re-parsing event files off disk.
  const adminEventStore = options.adminOptions?.workspace
    ? HostEventStore.fromWorkspaceDir(options.adminOptions.workspace.root)
    : undefined;

  // When a built web app dist is present, the SPA takes over the portal page
  // URLs (/session, /admin, /link) through the fallback seat; API routes and
  // the stream/message endpoints stay with the daemon.
  const webDistIndex = options.webDistIndex;
  const distActive = webDistIndex !== undefined && existsSync(webDistIndex);

  registerCoreRoutes(webServer, options);
  registerAdminRoutes(webServer, options, adminEventStore, distActive);
  registerSessionRoutes(webServer, options, distActive);
  registerLoginRoutes(webServer, loginHandler, distActive);
  if (options.bindingTokenStore) {
    const bindingHandler = createBindingHandler(options.bindingTokenStore);
    for (const path of ["/binding", "/api/binding/info"]) {
      webServer.register({
        kind: "exact",
        path,
        handler: (req, res) => bindingHandler(req, res, requestUrl(req)),
      });
    }
  }
  if (distActive) registerWebAppDist(webServer, webDistIndex);

  const bindHost = bindHostOf();
  let server: Server;
  try {
    server = await webServer.listen({
      port: options.port,
      host: bindHost,
      onRequestError: (req, err) => {
        log.logWarning(
          "Web server request error",
          err instanceof Error ? err.message : String(err),
        );
        void req;
      },
    });
  } catch (err) {
    // Listen failure (e.g. port already in use) is logged, not fatal — the
    // daemon keeps running with the web surface down, as before.
    log.logWarning("Web server failed to start", err instanceof Error ? err.message : String(err));
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

  server.on("error", (err) => {
    log.logWarning("Web server error", err.message);
  });

  return server;
}
