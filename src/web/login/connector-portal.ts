import type { IncomingMessage, ServerResponse } from "node:http";
import {
  isConnectorService,
  type ConnectorGateway,
  type ConnectorService,
} from "../../connector/gateway.js";
import { ConnectorError } from "../../connector/client.js";
import * as log from "../../log.js";
import { PRODUCT_NAME } from "../../platform-messages.js";
import { escapeHtml, readJsonBody, renderPortalShell } from "../portal-shell.js";
import { enforceCsrf } from "./portal.js";
import type { InMemoryLinkTokenStore } from "./store.js";
import type { NotifyFn } from "./types.js";

interface ConnectorApiBody {
  token: string;
  service: string;
}

/**
 * Connector onboarding portal: lets the holder of a /login link token
 * authorize provider connections on the Open Connector gateway for their
 * conversation's principal (the link token's vault key). The link token is
 * peeked, not consumed — one short-lived link may connect several services.
 *
 * Routes:
 *   GET  /connector?token=xxx          — connection status page
 *   POST /api/connector/start          — begin OAuth for one service
 *   POST /api/connector/status         — poll until the connection exists
 *   POST /api/connector/disconnect     — remove mapping + connector credential
 */
export function createConnectorRequestHandler(
  gateway: ConnectorGateway,
  linkTokenStore: InMemoryLinkTokenStore,
  notify: NotifyFn,
): (req: IncomingMessage, res: ServerResponse, url: URL) => boolean {
  const resolve = (
    rawToken: string,
    rawService: string,
  ):
    | { error: string; status: number }
    | { vaultId: string; platform: string; conversationId: string; service: ConnectorService } => {
    const linkToken = linkTokenStore.peek(rawToken);
    if (!linkToken) {
      return {
        error: "This link is invalid or has expired. Ask the bot for a new /login link.",
        status: 400,
      };
    }
    if (!isConnectorService(rawService)) {
      return { error: `Unknown connector service: ${rawService}`, status: 400 };
    }
    return {
      vaultId: linkToken.vaultId,
      platform: linkToken.platform,
      conversationId: linkToken.conversationId,
      service: rawService,
    };
  };

  const handleApi = (
    req: IncomingMessage,
    res: ServerResponse,
    run: (
      resolved: Exclude<ReturnType<typeof resolve>, { error: string; status: number }>,
    ) => Promise<Record<string, unknown>>,
  ): void => {
    void readJsonBody(req, res, 16 * 1024).then(async (body) => {
      if (body === null) return;
      const data = body as Partial<ConnectorApiBody>;
      const resolved = resolve(data.token ?? "", data.service ?? "");
      if ("error" in resolved) {
        sendJson(res, resolved.status, { error: resolved.error });
        return;
      }
      try {
        sendJson(res, 200, await run(resolved));
      } catch (err) {
        const message = err instanceof ConnectorError ? err.message : "Connector request failed";
        if (!(err instanceof ConnectorError)) {
          log.logWarning(
            "Connector portal request failed",
            err instanceof Error ? err.message : String(err),
          );
        }
        sendJson(res, 502, { error: message });
      }
    });
  };

  return (req, res, url) => {
    if (req.method === "GET" && url.pathname === "/connector") {
      handleConnectorPage(res, url, gateway, linkTokenStore);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/connector/start") {
      if (!enforceCsrf(req, res)) return true;
      handleApi(req, res, async ({ vaultId, service }) => {
        const { authorizationUrl } = await gateway.startOnboarding(vaultId, service);
        return { authorizationUrl };
      });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/connector/status") {
      if (!enforceCsrf(req, res)) return true;
      handleApi(req, res, async ({ vaultId, platform, conversationId, service }) => {
        const { connected, newly } = await gateway.completeOnboarding(vaultId, service);
        if (newly) {
          const label =
            gateway.status(vaultId).find((entry) => entry.service === service)?.label ?? service;
          notify(
            platform,
            conversationId,
            `✅ ${label} connected through the connector gateway. Host-side tools can now ` +
              `act on that account; its credentials stay out of the sandbox.`,
          ).catch((err: Error) => log.logWarning("Connector connect notify failed", err.message));
        }
        return { connected };
      });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/connector/disconnect") {
      if (!enforceCsrf(req, res)) return true;
      handleApi(req, res, async ({ vaultId, service }) => {
        await gateway.disconnect(vaultId, service);
        return { ok: true };
      });
      return true;
    }

    return false;
  };
}

function handleConnectorPage(
  res: ServerResponse,
  url: URL,
  gateway: ConnectorGateway,
  linkTokenStore: InMemoryLinkTokenStore,
): void {
  const rawToken = url.searchParams.get("token") ?? "";
  const linkToken = linkTokenStore.peek(rawToken);
  if (!linkToken) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      renderConnectorErrorPage(
        "This link is invalid or has expired. Ask the bot for a new /login link.",
      ),
    );
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(renderConnectorPage(rawToken, gateway.status(linkToken.vaultId)));
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function renderConnectorErrorPage(message: string): string {
  return renderConnectorShell(`<section class="card"><div class="stack">
      <p class="eyebrow">${PRODUCT_NAME}</p>
      <h1 class="page-title">Connector</h1>
      <div class="status err">${escapeHtml(message)}</div>
    </div></section>`);
}

function renderConnectorPage(
  token: string,
  services: ReturnType<ConnectorGateway["status"]>,
): string {
  const rows = services
    .map(
      ({
        service,
        label,
        connected,
      }) => `<div class="connector-row" data-service="${escapeHtml(service)}">
    <div>
      <strong>${escapeHtml(label)}</strong>
      <span class="connector-state" data-role="state">${connected ? "Connected" : "Not connected"}</span>
    </div>
    <div>
      <button class="primary-button" data-role="connect" ${connected ? "hidden" : ""}>Connect</button>
      <button class="primary-button" data-role="disconnect" ${connected ? "" : "hidden"}>Disconnect</button>
    </div>
  </div>`,
    )
    .join("\n");

  return renderConnectorShell(
    `<section class="card stack">
  <p class="eyebrow">${PRODUCT_NAME}</p>
  <h1 class="page-title">Connected services</h1>
  <p>Authorize provider accounts on the host-side connector gateway. The agent gets
  read-only tools backed by these accounts; OAuth tokens never enter the sandbox.</p>
  ${rows}
  <div id="result" class="result" aria-live="polite"></div>
</section>
<script>
  const token = ${JSON.stringify(token)};

  function showResult(message, ok) {
    const result = document.getElementById('result');
    result.style.display = 'block';
    result.className = ok ? 'result ok' : 'result err';
    result.textContent = message;
  }

  async function post(path, service) {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, service }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error ?? ('HTTP ' + r.status));
    return data;
  }

  function setConnected(row, connected) {
    row.querySelector('[data-role="state"]').textContent = connected ? 'Connected' : 'Not connected';
    row.querySelector('[data-role="connect"]').hidden = connected;
    row.querySelector('[data-role="disconnect"]').hidden = !connected;
  }

  async function pollUntilConnected(row, service) {
    for (let i = 0; i < 60; i++) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 2000));
      const data = await post('/api/connector/status', service);
      if (data.connected) {
        setConnected(row, true);
        showResult(service + ' connected.', true);
        return;
      }
    }
    showResult('Timed out waiting for ' + service + ' authorization. Reload to retry.', false);
  }

  for (const row of document.querySelectorAll('.connector-row')) {
    const service = row.dataset.service;
    row.querySelector('[data-role="connect"]').addEventListener('click', async () => {
      try {
        const data = await post('/api/connector/start', service);
        window.open(data.authorizationUrl, '_blank', 'noopener');
        showResult('Complete the authorization in the new tab; this page updates automatically.', true);
        await pollUntilConnected(row, service);
      } catch (err) {
        showResult('Error: ' + err.message, false);
      }
    });
    row.querySelector('[data-role="disconnect"]').addEventListener('click', async () => {
      try {
        await post('/api/connector/disconnect', service);
        setConnected(row, false);
        showResult(service + ' disconnected.', true);
      } catch (err) {
        showResult('Error: ' + err.message, false);
      }
    });
  }
</script>`,
  );
}

function renderConnectorShell(body: string): string {
  return renderPortalShell({
    activeView: "vault",
    pageTitle: "Connector",
    body,
    extraStyles: `
      .connector-row { display: flex; justify-content: space-between; align-items: center; gap: 1rem; padding: 0.5rem 0; border-bottom: 1px solid rgba(127, 127, 127, 0.25); }
      .connector-state { margin-left: 0.75rem; opacity: 0.75; }
      .result { display: none; }
    `,
  });
}
