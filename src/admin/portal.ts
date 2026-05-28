import type { IncomingMessage, ServerResponse } from "http";
import type { PlatformName } from "../adapter.js";
import { readEnv } from "../env.js";
import { PRODUCT_NAME } from "../ui-copy.js";
import { sharedVaultKey, type VaultManager } from "../vault.js";

// ── Types ──────────────────────────────────────────────────────────────────────

interface CommandUsage {
  cmd: string;
  desc: string;
}

interface CommandDef {
  id: string;
  name: string;
  aliases: string[];
  icon: string;
  description: string;
  note?: string;
  usages: CommandUsage[];
  constraints?: string[];
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
  portalBaseUrl?: string;
}

// ── Handler ────────────────────────────────────────────────────────────────────

export function handleAdminRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  adminToken: string | undefined,
  services?: AdminServices,
): boolean {
  if (!url.pathname.startsWith("/admin")) return false;

  if (!adminToken) {
    if (req.method === "GET" && url.pathname === "/admin") {
      res.writeHead(404);
      res.end();
      return true;
    }
    return false;
  }

  // Main dashboard page
  if (req.method === "GET" && url.pathname === "/admin") {
    const provided = url.searchParams.get("token");
    if (provided !== adminToken) {
      res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderAdminErrorPage("Access denied. Provide a valid ?token= parameter."));
      return true;
    }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(renderAdminPage());
    return true;
  }

  // API routes
  if (url.pathname.startsWith("/admin/api/")) {
    routeApiRequest(req, res, url, adminToken, services);
    return true;
  }

  return false;
}

// ── API routing ────────────────────────────────────────────────────────────────

function routeApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  adminToken: string,
  services?: AdminServices,
): void {
  if (req.method === "GET") {
    if (url.searchParams.get("token") !== adminToken) {
      jsonRes(res, 403, { error: "Unauthorized" });
      return;
    }
    if (url.pathname === "/admin/api/vaults") {
      serveVaultsList(res, services);
      return;
    }
    if (url.pathname === "/admin/api/status") {
      serveStatus(res, services);
      return;
    }
    jsonRes(res, 404, { error: "Not found" });
    return;
  }

  if (req.method === "POST") {
    void readJsonBody(req, res, (body) => {
      const bodyToken = typeof body.token === "string" ? body.token : "";
      if (bodyToken !== adminToken) {
        jsonRes(res, 403, { error: "Unauthorized" });
        return;
      }
      if (url.pathname === "/admin/api/vaults/delete") {
        serveVaultDelete(res, body, services);
        return;
      }
      if (url.pathname === "/admin/api/vaults/link") {
        serveVaultLink(res, body, services);
        return;
      }
      jsonRes(res, 404, { error: "Not found" });
    });
    return;
  }

  jsonRes(res, 405, { error: "Method not allowed" });
}

// ── API handlers ───────────────────────────────────────────────────────────────

function serveVaultsList(res: ServerResponse, services?: AdminServices): void {
  if (!services) {
    jsonRes(res, 503, { error: "Vault service not available" });
    return;
  }

  const names = services.vaultManager.listSharedVaults();
  const vaults = names.map((name) => {
    const vaultId = sharedVaultKey(name);
    const vault = vaultId ? services.vaultManager.resolve(vaultId) : undefined;
    return {
      name,
      envKeys: vault ? Object.keys(vault.env).toSorted() : [],
      mountTargets: vault ? [...new Set(vault.mounts.map((m) => m.target))].toSorted() : [],
    };
  });

  jsonRes(res, 200, { vaults });
}

function serveVaultDelete(
  res: ServerResponse,
  body: Record<string, unknown>,
  services?: AdminServices,
): void {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    jsonRes(res, 400, { error: "Missing name" });
    return;
  }
  if (!services) {
    jsonRes(res, 503, { error: "Vault service not available" });
    return;
  }

  try {
    const deleted = services.vaultManager.deleteSharedVault(name);
    jsonRes(res, 200, { ok: true, deleted });
  } catch (err) {
    jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

function serveVaultLink(
  res: ServerResponse,
  body: Record<string, unknown>,
  services?: AdminServices,
): void {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    jsonRes(res, 400, { error: "Missing name" });
    return;
  }
  if (!services) {
    jsonRes(res, 503, { error: "Services not available" });
    return;
  }
  if (!services.portalBaseUrl) {
    jsonRes(res, 503, {
      error: "Portal URL not configured. Set MIKAN_LINK_URL to enable link generation.",
    });
    return;
  }

  const vaultId = sharedVaultKey(name);
  if (!vaultId) {
    jsonRes(res, 400, { error: "Invalid vault name" });
    return;
  }

  try {
    const { token } = services.linkTokenStore.create(
      "slack" as PlatformName,
      "admin",
      "admin-shared-vault",
      vaultId,
      "",
    );
    const linkUrl = `${services.portalBaseUrl}/link?token=${encodeURIComponent(token)}`;
    jsonRes(res, 200, { ok: true, url: linkUrl });
  } catch (err) {
    jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

function serveStatus(res: ServerResponse, services?: AdminServices): void {
  const linkUrl = readEnv("LINK_URL");
  const adminTokenConfigured = !!readEnv("ADMIN_TOKEN");
  const sharedVaultCount = services ? services.vaultManager.listSharedVaults().length : null;

  jsonRes(res, 200, {
    linkUrl: linkUrl ?? null,
    adminTokenConfigured,
    vaultServiceAvailable: !!services?.vaultManager,
    sharedVaultCount,
    portalBaseUrl: services?.portalBaseUrl ?? null,
  });
}

// ── Utilities ──────────────────────────────────────────────────────────────────

function jsonRes(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
  callback: (body: Record<string, unknown>) => void,
): Promise<void> {
  let data = "";
  let tooLarge = false;

  await new Promise<void>((resolve) => {
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      data += chunk.toString();
      if (data.length > 32 * 1024) {
        tooLarge = true;
        res.writeHead(413);
        res.end();
        req.destroy();
      }
    });
    req.on("end", resolve);
    req.on("error", resolve);
  });

  if (tooLarge) return;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(data) as Record<string, unknown>;
  } catch {
    jsonRes(res, 400, { error: "Invalid JSON" });
    return;
  }

  callback(parsed);
}

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

// ── Data ───────────────────────────────────────────────────────────────────────

const COMMANDS: CommandDef[] = [
  {
    id: "login",
    name: "/login",
    aliases: ["login", "/login", "/pi-login"],
    icon: "🔑",
    description: "管理個人或共享憑證，把 API key 與 OAuth token 安全地存進 vault。",
    note: "只能在與機器人的私訊 / DM 中使用，以保護你的憑證安全。Token 連結 15 分鐘後過期。",
    usages: [
      { cmd: "/login", desc: "開啟憑證設定頁面（API key 或 OAuth 模式）" },
      { cmd: "/login shared list", desc: "列出所有共享登入 profile" },
      { cmd: "/login shared create <name>", desc: "新建一個共享 profile" },
      { cmd: "/login shared update <name>", desc: "更新既有的共享 profile" },
      { cmd: "/login shared delete <name>", desc: "刪除共享 profile" },
      { cmd: "/login copy <name>", desc: "把共享 profile 複製進這個 conversation 的 vault" },
    ],
    constraints: ["僅限私訊 / DM"],
  },
  {
    id: "session",
    name: "/session",
    aliases: ["session", "/session", "/pi-session"],
    icon: "📺",
    description: "在瀏覽器裡查看目前對話的完整歷史紀錄，支援即時串流與互動回覆。",
    note: "連結 24 小時後過期。頁面只顯示對話內容，回覆不會送回 Slack / Telegram。",
    usages: [{ cmd: "/session", desc: "取得本 conversation 的 Session View 連結" }],
    constraints: [
      "僅限私訊 / DM（或 bot 支援私訊傳送的平台）",
      "需設定 MIKAN_LINK_URL 或 MIKAN_LINK_PORT",
    ],
  },
  {
    id: "model",
    name: "/model",
    aliases: ["model", "/model", "/pi-model"],
    icon: "🤖",
    description: "查看或即時切換這個 conversation 使用的 AI 模型與 thinking level。",
    note: "模型切換即時生效，不需重啟 sandbox。若有工作執行中，必須等完成或 /stop 後才能切換。",
    usages: [
      { cmd: "/model", desc: "顯示目前 conversation 使用的 provider/model 與 thinking level" },
      {
        cmd: "/model <provider>/<model>",
        desc: "切換到指定模型，例如 /model anthropic/claude-sonnet-4-6",
      },
      {
        cmd: "/model <provider>/<model>:<thinking>",
        desc: "切換模型並設定 thinking level（off / minimal / low / medium / high / xhigh）",
      },
    ],
  },
  {
    id: "new",
    name: "/new",
    aliases: ["new", "/new", "/pi-new"],
    icon: "🆕",
    description: "清除目前 conversation 的上下文，開始一個全新的對話。",
    note: "此操作不可逆，清除後無法恢復舊的上下文。若需保留歷史，請先用 /session 備份。",
    usages: [{ cmd: "/new", desc: "清空 context，讓下一則訊息從乾淨狀態開始" }],
    constraints: ["僅限私訊 / DM"],
  },
  {
    id: "sandbox",
    name: "/sandbox",
    aliases: ["/sandbox", "/pi-sandbox"],
    icon: "📦",
    description: "查看或設定 sandbox container 的資源限制與 workspace mount 模式。",
    note: "boost 效果持續到 container 被關閉為止。workspace mode 在下次 provision 時生效。",
    usages: [
      { cmd: "/sandbox", desc: "顯示目前 sandbox 的 CPU/Memory 限制與 workspace mount 模式" },
      { cmd: "/sandbox boost", desc: "暫時把這個 conversation 的 sandbox 提升到 boost 規格" },
      {
        cmd: "/sandbox private",
        desc: "設為 private workspace mode：只掛載 private workspace 與 conversation 目錄",
      },
      {
        cmd: "/sandbox full",
        desc: "設為 full workspace mode：把整個 host workspace 掛到 /workspace",
      },
    ],
    constraints: [
      "僅支援 image:* managed sandbox",
      "需在全域 settings.json 設定 sandbox.boost 才能 boost",
    ],
  },
  {
    id: "auto-reply",
    name: "/auto-reply",
    aliases: [
      "auto-reply",
      "autoreply",
      "/auto-reply",
      "/autoreply",
      "/pi-auto-reply",
      "/pi-autoreply",
    ],
    icon: "🔄",
    description: "在 group / channel 裡啟用或停用機器人的自動回覆模式。",
    note: "auto-reply 只能在 group/channel 設定，不能在私訊中使用。",
    usages: [
      { cmd: "/auto-reply", desc: "顯示目前 channel 的 auto-reply 狀態" },
      { cmd: "/auto-reply status", desc: "同上，明確查詢狀態" },
      { cmd: "/auto-reply on", desc: "啟用 auto-reply" },
      { cmd: "/auto-reply off", desc: "停用 auto-reply" },
    ],
    constraints: ["僅限 group / channel（不能在私訊中使用）"],
  },
];

const CREDENTIAL_PRESETS = [
  {
    id: "cloudflare_wrangler",
    label: "Cloudflare / Wrangler",
    cls: "cloudflare",
    abbr: "" as const,
    svgPath: true,
    desc: "CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID",
  },
  {
    id: "openai",
    label: "OpenAI",
    cls: "openai",
    abbr: "OA" as const,
    svgPath: false,
    desc: "OPENAI_API_KEY",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    cls: "anthropic",
    abbr: "AI" as const,
    svgPath: false,
    desc: "ANTHROPIC_API_KEY",
  },
  {
    id: "gemini",
    label: "Gemini",
    cls: "gemini",
    abbr: "G" as const,
    svgPath: false,
    desc: "GEMINI_API_KEY + GOOGLE_API_KEY",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    cls: "openrouter",
    abbr: "OR" as const,
    svgPath: false,
    desc: "OPENROUTER_API_KEY",
  },
  {
    id: "github_pat",
    label: "GitHub PAT",
    cls: "github",
    abbr: "GH" as const,
    svgPath: false,
    desc: "GH_TOKEN + GITHUB_TOKEN",
  },
  {
    id: "vercel",
    label: "Vercel",
    cls: "vercel",
    abbr: "V" as const,
    svgPath: false,
    desc: "VERCEL_TOKEN",
  },
  {
    id: "sentry",
    label: "Sentry",
    cls: "sentry",
    abbr: "S" as const,
    svgPath: false,
    desc: "SENTRY_AUTH_TOKEN",
  },
];

const OAUTH_SERVICES = [
  {
    id: "github",
    label: "GitHub OAuth",
    desc: "GH_TOKEN + GITHUB_OAUTH_*",
    cls: "github",
    abbr: "GH" as const,
  },
  {
    id: "google_workspace_cli",
    label: "Google Workspace CLI",
    desc: "Mounted → /root/.config/gws/credentials.json",
    cls: "gws",
    abbr: "GW" as const,
  },
  {
    id: "google_cloud_sdk",
    label: "Google Cloud SDK (gcloud)",
    desc: "GOOGLE_APPLICATION_CREDENTIALS",
    cls: "gcs",
    abbr: "GC" as const,
  },
];

// ── HTML renderers ─────────────────────────────────────────────────────────────

function renderServiceLogo(id: string, cls: string, abbr: string): string {
  if (id === "cloudflare_wrangler") {
    return `<span class="service-logo ${cls}" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none">
        <path d="M8.5 17.5h8.2a2.9 2.9 0 0 0 .4-5.78A4.45 4.45 0 0 0 8.9 10.4a3.7 3.7 0 0 0-.4 7.1Z" fill="white" fill-opacity="0.98"/>
        <path d="M6.6 17.5h5.1a2.3 2.3 0 0 0 0-4.6 3.1 3.1 0 0 0-3-2.2 3.23 3.23 0 0 0-3.18 3.64A2.67 2.67 0 0 0 6.6 17.5Z" fill="white"/>
      </svg>
    </span>`;
  }
  return `<span class="service-logo ${cls}" aria-hidden="true"><span class="service-logo-text">${esc(abbr)}</span></span>`;
}

function renderCommandCard(cmd: CommandDef): string {
  const aliasPills = cmd.aliases.map((a) => `<code class="alias-pill">${esc(a)}</code>`).join("");

  const usageRows = cmd.usages
    .map(
      (u) => `<div class="usage-row">
        <code class="usage-cmd">${esc(u.cmd)}</code>
        <span class="usage-desc">${esc(u.desc)}</span>
      </div>`,
    )
    .join("");

  const noteHtml = cmd.note
    ? `<div class="cmd-note"><span class="note-icon" aria-hidden="true">ⓘ</span>${esc(cmd.note)}</div>`
    : "";

  const constraintList = cmd.constraints
    ? `<div class="cmd-constraints">
        <span class="constraint-heading">制約條件</span>
        <ul>${cmd.constraints.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>
      </div>`
    : "";

  return `<div class="cmd-card" id="cmd-${esc(cmd.id)}">
    <div class="cmd-header">
      <span class="cmd-icon" aria-hidden="true">${cmd.icon}</span>
      <div class="cmd-title-group">
        <code class="cmd-name">${esc(cmd.name)}</code>
        <div class="cmd-aliases">${aliasPills}</div>
      </div>
    </div>
    <p class="cmd-desc">${esc(cmd.description)}</p>
    ${noteHtml}
    <div class="cmd-usages">
      <div class="usage-heading">Usage</div>
      ${usageRows}
    </div>
    ${constraintList}
  </div>`;
}

function renderOverviewSection(): string {
  return `<div class="tab-panel active" id="panel-overview">
    <div class="overview-grid">
      <div class="card overview-card">
        <p class="eyebrow">Product</p>
        <h2 class="card-title">${PRODUCT_NAME}</h2>
        <p class="card-desc">多平台 AI coding agent，整合 Slack、Telegram、Discord。</p>
      </div>

      <div class="card overview-card">
        <p class="eyebrow">Slash Commands</p>
        <h2 class="card-title stat-number">${COMMANDS.length}</h2>
        <div class="overview-cmd-list">
          ${COMMANDS.map(
            (c) =>
              `<a class="overview-cmd-chip" href="#cmd-${esc(c.id)}" data-switch-tab="commands">
            <span aria-hidden="true">${c.icon}</span> <code>${esc(c.name)}</code>
          </a>`,
          ).join("")}
        </div>
      </div>

      <div class="card overview-card">
        <p class="eyebrow">Credential Presets</p>
        <h2 class="card-title stat-number">${CREDENTIAL_PRESETS.length}</h2>
        <div class="preset-logo-row">
          ${CREDENTIAL_PRESETS.map((p) => renderServiceLogo(p.id, p.cls, p.abbr)).join("")}
        </div>
      </div>

      <div class="card overview-card">
        <p class="eyebrow">OAuth Services</p>
        <h2 class="card-title stat-number">${OAUTH_SERVICES.length}</h2>
        <div class="overview-oauth-list">
          ${OAUTH_SERVICES.map((s) => `<span class="oauth-chip">${esc(s.label)}</span>`).join("")}
        </div>
      </div>
    </div>

    <div class="card" id="status-card">
      <p class="eyebrow">Server Status</p>
      <h2 class="card-title">運行狀態</h2>
      <div id="status-content"><div class="loading-msg">Loading…</div></div>
    </div>

    <div class="card quick-links-card">
      <p class="eyebrow">Quick Links</p>
      <h2 class="card-title">快速導覽</h2>
      <div class="quicklink-grid">
        <button class="quicklink-btn" data-switch-tab="vaults">
          <span class="quicklink-icon">🗄️</span>
          <span class="quicklink-label">Shared Vaults</span>
          <span class="quicklink-sub">共享憑證管理</span>
        </button>
        <button class="quicklink-btn" data-switch-tab="commands">
          <span class="quicklink-icon">⚡</span>
          <span class="quicklink-label">Commands</span>
          <span class="quicklink-sub">所有 slash commands</span>
        </button>
        <button class="quicklink-btn" data-switch-tab="login">
          <span class="quicklink-icon">🔑</span>
          <span class="quicklink-label">Login / Credentials</span>
          <span class="quicklink-sub">憑證 presets 與 OAuth</span>
        </button>
        <button class="quicklink-btn" data-switch-tab="session">
          <span class="quicklink-icon">📺</span>
          <span class="quicklink-label">Session View</span>
          <span class="quicklink-sub">Session 查看器說明</span>
        </button>
      </div>
    </div>
  </div>`;
}

function renderVaultsSection(): string {
  return `<div class="tab-panel" id="panel-vaults">
    <div class="card section-intro">
      <div class="section-intro-header">
        <div>
          <p class="eyebrow">Shared Vaults</p>
          <h2 class="card-title">共享 Vault 管理</h2>
          <p class="card-desc">管理所有共享登入 profile：查看儲存的 env key 名稱、產生 15 分鐘登入連結、或刪除整個 vault。</p>
        </div>
        <button class="refresh-btn" id="vaults-refresh-btn" onclick="loadVaults()" title="Refresh">↻ Refresh</button>
      </div>
    </div>

    <div class="card" id="vaults-card">
      <div id="vaults-content"><div class="loading-msg">Loading vaults…</div></div>
    </div>

    <div class="card">
      <p class="eyebrow">如何新增 Shared Vault</p>
      <h3 class="card-subtitle">透過 Bot 指令建立</h3>
      <p class="card-desc-sm" style="margin-bottom:10px">Shared Vault 需透過機器人私訊指令建立，管理員取得登入連結後分享給需要的用戶：</p>
      <div class="code-block-list">
        <div class="code-example"><code>/login shared create &lt;name&gt;</code><span>在 bot 私訊中建立共享 profile，取得登入連結</span></div>
        <div class="code-example"><code>/login copy &lt;name&gt;</code><span>用戶在私訊中把共享 profile 複製到自己的 vault</span></div>
      </div>
      <p class="card-desc-sm" style="margin-top:10px">建立後，可在上方列表點擊 <strong>Generate Link</strong> 直接從後台產生新的登入連結。</p>
    </div>
  </div>`;
}

function renderCommandsSection(): string {
  return `<div class="tab-panel" id="panel-commands">
    <div class="card section-intro">
      <p class="eyebrow">Commands</p>
      <h2 class="card-title">Slash Commands 完整參考</h2>
      <p class="card-desc">以下列出所有支援的 slash commands，包含別名、用法與限制條件。</p>
    </div>
    <div class="cmd-list">
      ${COMMANDS.map(renderCommandCard).join("")}
    </div>
  </div>`;
}

function renderLoginSection(): string {
  const presetCards = CREDENTIAL_PRESETS.map(
    (p) => `<div class="preset-row">
      ${renderServiceLogo(p.id, p.cls, p.abbr)}
      <div class="preset-info">
        <strong class="preset-label">${esc(p.label)}</strong>
        <code class="preset-envkeys">${esc(p.desc)}</code>
      </div>
    </div>`,
  ).join("");

  const oauthCards = OAUTH_SERVICES.map(
    (s) => `<div class="preset-row">
      <div class="service-logo ${s.cls}" aria-hidden="true"><span class="service-logo-text">${esc(s.abbr)}</span></div>
      <div class="preset-info">
        <strong class="preset-label">${esc(s.label)}</strong>
        <code class="preset-envkeys">${esc(s.desc)}</code>
      </div>
    </div>`,
  ).join("");

  return `<div class="tab-panel" id="panel-login">
    <div class="card section-intro">
      <p class="eyebrow">Login / Credentials</p>
      <h2 class="card-title">憑證管理系統</h2>
      <p class="card-desc">透過 <code>/login</code> 指令取得一次性連結，在安全的 Web UI 裡把 API keys 與 OAuth token 存入每個 conversation 的私有 vault。</p>
    </div>

    <div class="card">
      <p class="eyebrow">使用流程</p>
      <h3 class="card-subtitle">如何設定憑證</h3>
      <ol class="flow-steps">
        <li><span class="step-num">1</span><div><strong>私訊機器人</strong>，傳送 <code>/login</code></div></li>
        <li><span class="step-num">2</span><div>機器人回傳一個 <strong>15 分鐘有效</strong>的連結</div></li>
        <li><span class="step-num">3</span><div>點開連結，選擇 <strong>API key 模式</strong>或 <strong>OAuth 模式</strong></div></li>
        <li><span class="step-num">4</span><div>填入憑證並送出，機器人會通知你儲存成功</div></li>
      </ol>
    </div>

    <div class="two-col-grid">
      <div class="card">
        <p class="eyebrow">API Key Presets</p>
        <h3 class="card-subtitle">內建憑證 Presets</h3>
        <p class="card-desc-sm">下列 presets 有預設欄位，填入後自動寫入對應的環境變數：</p>
        <div class="preset-list">
          ${presetCards}
          <div class="preset-row preset-manual">
            <div class="service-logo manual" aria-hidden="true"><span class="service-logo-text">&gt;_</span></div>
            <div class="preset-info">
              <strong class="preset-label">Manual Entry</strong>
              <code class="preset-envkeys">任意 KEY=VALUE</code>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <p class="eyebrow">OAuth Services</p>
        <h3 class="card-subtitle">OAuth 整合服務</h3>
        <p class="card-desc-sm">點選 OAuth 模式，選擇以下服務並授權，token 自動存入 vault：</p>
        <div class="preset-list">${oauthCards}</div>
        <p class="card-desc-sm" style="margin-top:14px">自訂 OAuth service 可透過環境變數 <code>OAUTH_SERVICES_JSON</code> 注入。</p>
      </div>
    </div>

    <div class="card">
      <p class="eyebrow">Shared Profiles</p>
      <h3 class="card-subtitle">共享 Vault Profile</h3>
      <p class="card-desc">建立共享 profile 讓多個 conversation 共用同一套憑證。管理員可在 <button class="inline-tab-btn" data-switch-tab="vaults">Vaults 頁面</button> 直接產生登入連結。</p>
      <div class="code-block-list" style="margin-top:12px">
        <div class="code-example"><code>/login shared create &lt;name&gt;</code><span>建立共享 profile</span></div>
        <div class="code-example"><code>/login shared list</code><span>列出所有共享 profile</span></div>
        <div class="code-example"><code>/login copy &lt;name&gt;</code><span>複製共享 profile 到本 conversation</span></div>
        <div class="code-example"><code>/login shared delete &lt;name&gt;</code><span>刪除共享 profile</span></div>
      </div>
    </div>
  </div>`;
}

function renderSessionSection(): string {
  return `<div class="tab-panel" id="panel-session">
    <div class="card section-intro">
      <p class="eyebrow">Session View</p>
      <h2 class="card-title">Session 查看器</h2>
      <p class="card-desc">在瀏覽器中以時間軸方式瀏覽完整對話紀錄，支援即時串流與互動回覆。</p>
    </div>

    <div class="card">
      <p class="eyebrow">使用流程</p>
      <h3 class="card-subtitle">如何開啟 Session View</h3>
      <ol class="flow-steps">
        <li><span class="step-num">1</span><div>在私訊中傳送 <code>/session</code></div></li>
        <li><span class="step-num">2</span><div>機器人回傳一個 <strong>24 小時有效</strong>的 Session View 連結</div></li>
        <li><span class="step-num">3</span><div>點開連結即可在瀏覽器查看此 conversation 的完整歷史</div></li>
        <li><span class="step-num">4</span><div>可在頁面底部的 composer 傳訊息，<strong>不會</strong>送回 Slack/Telegram</div></li>
      </ol>
    </div>

    <div class="two-col-grid">
      <div class="card">
        <p class="eyebrow">頁面內容</p>
        <h3 class="card-subtitle">Session View 顯示資訊</h3>
        <ul class="feature-list">
          <li><span class="feature-dot" aria-hidden="true"></span>User 訊息（含時間戳與使用者名稱）</li>
          <li><span class="feature-dot" aria-hidden="true"></span>Assistant 回覆（含 Markdown 渲染）</li>
          <li><span class="feature-dot" aria-hidden="true"></span>Tool 呼叫與結果（含 code output）</li>
          <li><span class="feature-dot" aria-hidden="true"></span>System 事件（session 開始、結束等）</li>
          <li><span class="feature-dot" aria-hidden="true"></span>執行狀態（Running / Idle）即時更新</li>
          <li><span class="feature-dot" aria-hidden="true"></span>Fork / Thread 導航連結</li>
        </ul>
      </div>

      <div class="card">
        <p class="eyebrow">Config</p>
        <h3 class="card-subtitle">必要環境變數</h3>
        <div class="code-block-list">
          <div class="code-example"><code>MIKAN_LINK_URL=https://your-host.example.com</code><span>設定外部 base URL（production）</span></div>
          <div class="code-example"><code>MIKAN_LINK_PORT=8080</code><span>或指定 port，URL 從 request headers 推導</span></div>
        </div>
        <p class="card-desc-sm" style="margin-top:12px">若兩者都未設定，server 只綁 127.0.0.1，Session View 連結無法對外使用。</p>
      </div>
    </div>
  </div>`;
}

function renderAdminPage(): string {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Admin — ${PRODUCT_NAME}</title>
  <style>${adminStyles}</style>
</head>
<body>
  <main class="shell">
    <header class="hero-card">
      <div class="hero-top">
        <div class="hero-title-group">
          <span class="hero-wordmark">${PRODUCT_NAME}</span>
          <div class="hero-heading-row">
            <h1 class="hero-title">Admin Dashboard</h1>
            <span class="admin-badge">admin</span>
          </div>
          <p class="hero-subtitle">統一後台管理頁面 — Shared Vaults / Slash Commands / Login / Session View</p>
        </div>
      </div>
    </header>

    <nav class="tab-nav" role="tablist" aria-label="Admin sections">
      <button class="tab-btn active" role="tab" aria-selected="true" aria-controls="panel-overview" data-tab="overview">Overview</button>
      <button class="tab-btn" role="tab" aria-selected="false" aria-controls="panel-vaults" data-tab="vaults">Vaults</button>
      <button class="tab-btn" role="tab" aria-selected="false" aria-controls="panel-commands" data-tab="commands">Commands</button>
      <button class="tab-btn" role="tab" aria-selected="false" aria-controls="panel-login" data-tab="login">Login</button>
      <button class="tab-btn" role="tab" aria-selected="false" aria-controls="panel-session" data-tab="session">Session View</button>
    </nav>

    ${renderOverviewSection()}
    ${renderVaultsSection()}
    ${renderCommandsSection()}
    ${renderLoginSection()}
    ${renderSessionSection()}
  </main>

  <script>
    const adminToken = new URLSearchParams(window.location.search).get('token') || '';

    // ── Tab switching ────────────────────────────────────────────────────────────

    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabPanels = document.querySelectorAll('.tab-panel');
    const loadedTabs = new Set(['overview']);

    function switchTab(tabId, opts) {
      tabBtns.forEach((btn) => {
        const isActive = btn.dataset.tab === tabId;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
      });
      tabPanels.forEach((panel) => {
        panel.classList.toggle('active', panel.id === 'panel-' + tabId);
      });
      if (!opts || !opts.noScroll) window.scrollTo({ top: 0, behavior: 'smooth' });

      // Lazy-load tab data on first visit
      if (!loadedTabs.has(tabId)) {
        loadedTabs.add(tabId);
        if (tabId === 'vaults') loadVaults();
      }
    }

    tabBtns.forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    document.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target.closest('[data-switch-tab]') : null;
      if (!(target instanceof HTMLElement)) return;
      const tabId = target.dataset.switchTab;
      if (!tabId) return;
      switchTab(tabId);
      const anchor = target instanceof HTMLAnchorElement ? target.getAttribute('href') : null;
      if (anchor && anchor.startsWith('#')) {
        event.preventDefault();
        setTimeout(() => {
          const el = document.querySelector(anchor);
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 60);
      }
    });

    // ── Helpers ──────────────────────────────────────────────────────────────────

    function escHtml(str) {
      return String(str).replace(/[&<>"']/g, (c) => (
        {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]
      ));
    }

    function escAttr(str) {
      return String(str).replace(/["'&<>]/g, (c) => (
        {'"':'&quot;',"'":'&#39;','&':'&amp;','<':'&lt;','>':'&gt;'}[c]
      ));
    }

    async function copyToClipboard(text) {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        prompt('Copy this link:', text);
      }
    }

    // ── Server status ────────────────────────────────────────────────────────────

    async function loadStatus() {
      const container = document.getElementById('status-content');
      if (!container) return;
      try {
        const r = await fetch('/admin/api/status?token=' + encodeURIComponent(adminToken));
        const data = await r.json();
        if (!r.ok) {
          container.innerHTML = '<p class="err-msg">' + escHtml(data.error || 'Failed') + '</p>';
          return;
        }
        container.innerHTML = renderStatusCards(data);
      } catch (err) {
        container.innerHTML = '<p class="err-msg">Network error: ' + escHtml(err.message) + '</p>';
      }
    }

    function renderStatusCards(data) {
      const items = [
        {
          label: 'Portal URL',
          value: data.linkUrl || 'Not configured',
          ok: !!data.linkUrl,
          note: data.linkUrl ? null : 'Set MIKAN_LINK_URL to enable external links.',
        },
        {
          label: 'Admin Token',
          value: data.adminTokenConfigured ? 'Configured ✓' : 'Not set',
          ok: data.adminTokenConfigured,
        },
        {
          label: 'Vault Service',
          value: data.vaultServiceAvailable ? 'Available ✓' : 'Not available',
          ok: data.vaultServiceAvailable,
        },
        {
          label: 'Shared Vaults',
          value: data.sharedVaultCount !== null ? String(data.sharedVaultCount) : 'N/A',
          ok: true,
          action: data.sharedVaultCount > 0
            ? \`<button class="status-action-btn" onclick="switchTab('vaults')">Manage →</button>\`
            : null,
        },
      ];

      return '<div class="status-grid">' + items.map((item) => \`
        <div class="status-item \${item.ok ? 'status-ok' : 'status-warn'}">
          <span class="status-label">\${escHtml(item.label)}</span>
          <span class="status-value">\${escHtml(item.value)}</span>
          \${item.note ? '<span class="status-note">' + escHtml(item.note) + '</span>' : ''}
          \${item.action || ''}
        </div>
      \`).join('') + '</div>';
    }

    // ── Vault management ─────────────────────────────────────────────────────────

    async function loadVaults() {
      const container = document.getElementById('vaults-content');
      const btn = document.getElementById('vaults-refresh-btn');
      if (!container) return;
      container.innerHTML = '<div class="loading-msg">Loading vaults…</div>';
      if (btn) { btn.disabled = true; btn.textContent = '↻ Loading…'; }

      try {
        const r = await fetch('/admin/api/vaults?token=' + encodeURIComponent(adminToken));
        const data = await r.json();

        if (!r.ok) {
          container.innerHTML = '<div class="err-msg">' + escHtml(data.error || 'Failed to load vaults') + '</div>';
          return;
        }

        if (data.vaults.length === 0) {
          container.innerHTML = \`<div class="empty-state">
            <p>目前沒有共享 Vault。</p>
            <p>透過機器人私訊 <code>/login shared create &lt;name&gt;</code> 建立第一個。</p>
          </div>\`;
          return;
        }

        container.innerHTML = data.vaults.map(renderVaultRow).join('');
      } catch (err) {
        container.innerHTML = '<div class="err-msg">Network error: ' + escHtml(err.message) + '</div>';
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = '↻ Refresh'; }
      }
    }

    function renderVaultRow(vault) {
      const keysHtml = vault.envKeys.length > 0
        ? vault.envKeys.map((k) => '<code class="env-key-chip">' + escHtml(k) + '</code>').join('')
        : '<span class="no-keys-msg">尚無 env key</span>';

      const mountHtml = vault.mountTargets.length > 0
        ? '<div class="vault-mounts">' +
          vault.mountTargets.map((t) => '<code class="mount-chip">' + escHtml(t) + '</code>').join('') +
          '</div>'
        : '';

      const id = escAttr(vault.name);

      return \`<div class="vault-row" data-vault-name="\${id}">
        <div class="vault-row-top">
          <div class="vault-row-info">
            <span class="vault-name">\${escHtml(vault.name)}</span>
            <span class="vault-counts">
              \${vault.envKeys.length} key\${vault.envKeys.length !== 1 ? 's' : ''}
              \${vault.mountTargets.length ? ' · ' + vault.mountTargets.length + ' file' + (vault.mountTargets.length !== 1 ? 's' : '') : ''}
            </span>
          </div>
          <div class="vault-row-actions">
            <button class="vault-btn vault-btn-link" onclick="generateVaultLink('\${id}', this)">Generate Link</button>
            <button class="vault-btn vault-btn-delete" onclick="deleteVault('\${id}', this)">Delete</button>
          </div>
        </div>
        <div class="vault-env-keys">\${keysHtml}</div>
        \${mountHtml}
        <div class="vault-link-result" id="vault-link-\${id}" style="display:none"></div>
        <div class="vault-action-feedback" id="vault-feedback-\${id}" style="display:none"></div>
      </div>\`;
    }

    async function generateVaultLink(name, btn) {
      const resultEl = document.getElementById('vault-link-' + name);
      if (!resultEl) return;
      btn.disabled = true;
      btn.textContent = 'Generating…';

      try {
        const r = await fetch('/admin/api/vaults/link', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: adminToken, name }),
        });
        const data = await r.json();

        resultEl.style.display = 'block';
        if (!r.ok || !data.ok) {
          resultEl.className = 'vault-link-result err';
          resultEl.textContent = data.error || 'Failed to generate link';
          return;
        }

        const url = data.url;
        resultEl.className = 'vault-link-result ok';
        resultEl.innerHTML =
          '<span class="link-label">Login link (15 min):</span>' +
          '<a class="link-url" href="' + escHtml(url) + '" target="_blank" rel="noopener">' + escHtml(url) + '</a>' +
          '<button class="copy-link-btn" onclick="copyToClipboard(' + JSON.stringify(url) + ')">Copy</button>';
      } catch (err) {
        resultEl.style.display = 'block';
        resultEl.className = 'vault-link-result err';
        resultEl.textContent = 'Network error: ' + err.message;
      } finally {
        btn.disabled = false;
        btn.textContent = 'Generate Link';
      }
    }

    async function deleteVault(name, btn) {
      if (!confirm('Delete shared vault "' + name + '"?\\nThis will permanently remove all stored credentials. This cannot be undone.')) return;

      btn.disabled = true;
      btn.textContent = 'Deleting…';

      try {
        const r = await fetch('/admin/api/vaults/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: adminToken, name }),
        });
        const data = await r.json();

        if (!r.ok || !data.ok) {
          btn.disabled = false;
          btn.textContent = 'Delete';
          alert(data.error || 'Failed to delete vault');
          return;
        }

        // Animate out and reload
        const row = btn.closest('.vault-row');
        if (row) {
          row.style.opacity = '0';
          row.style.transform = 'translateX(8px)';
          row.style.transition = 'opacity 200ms, transform 200ms';
          setTimeout(() => loadVaults(), 250);
        } else {
          await loadVaults();
        }
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Delete';
        alert('Network error: ' + err.message);
      }
    }

    // ── Init ─────────────────────────────────────────────────────────────────────

    loadStatus();
  </script>
</body>
</html>`;
}

function renderAdminErrorPage(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Access Denied — ${PRODUCT_NAME}</title>
  <style>${adminStyles}</style>
</head>
<body>
  <main class="shell" style="max-width:480px">
    <div class="card" style="text-align:center;padding:40px 32px">
      <p class="eyebrow">${PRODUCT_NAME} admin</p>
      <h1 class="hero-title" style="margin:12px 0 16px">Access Denied</h1>
      <div class="status-err-block">${esc(message)}</div>
    </div>
  </main>
</body>
</html>`;
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const adminStyles = `
  @import url('https://fonts.googleapis.com/css2?family=Lora:wght@400;600&family=DM+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');

  :root {
    --bg: #f0ece3;
    --surface: #ffffff;
    --border: rgba(0, 0, 0, 0.08);
    --text: #18181b;
    --muted: #71717a;
    --subtle: #a1a1aa;
    --accent: #d97706;

    --ok-bg: #f0fdf4;
    --ok-text: #15803d;
    --ok-border: rgba(21, 128, 61, 0.16);
    --warn-bg: #fffbeb;
    --warn-text: #92400e;
    --warn-border: rgba(217, 119, 6, 0.18);
    --err-bg: #fef2f2;
    --err-text: #b91c1c;
    --err-border: rgba(185, 28, 28, 0.14);

    --service-cloudflare: linear-gradient(180deg, #ffb66d 0%, #f48120 100%);
    --service-openai: linear-gradient(180deg, #3e4045 0%, #111315 100%);
    --service-anthropic: linear-gradient(180deg, #d6b48c 0%, #9a6d3a 100%);
    --service-gemini: linear-gradient(180deg, #8ab4ff 0%, #5b6cff 100%);
    --service-openrouter: linear-gradient(180deg, #8c8cff 0%, #4f46e5 100%);
    --service-github: linear-gradient(180deg, #4a4f57 0%, #1b1f23 100%);
    --service-vercel: linear-gradient(180deg, #4a4f57 0%, #000 100%);
    --service-sentry: linear-gradient(180deg, #7c5cff 0%, #3f2e8c 100%);
    --service-manual: linear-gradient(180deg, #43474d 0%, #1c1e21 100%);
    --service-gws: linear-gradient(180deg, #4285f4 0%, #1a56c4 100%);
    --service-gcs: linear-gradient(180deg, #34a853 0%, #1a8334 100%);
  }

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    min-height: 100vh;
    padding: 32px 20px 60px;
    display: flex;
    flex-direction: column;
    align-items: center;
    background-color: var(--bg);
    background-image: radial-gradient(ellipse 80% 40% at 50% -10%, rgba(255,255,255,0.65) 0%, transparent 70%);
    color: var(--text);
    font-family: 'DM Sans', 'Segoe UI', system-ui, sans-serif;
    font-size: 15px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }

  .shell {
    width: 100%;
    max-width: 900px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  /* ── Hero ─────────────────────────────────────────────────────────────── */

  .hero-card {
    padding: 28px 32px 24px;
    border: 1px solid var(--border);
    border-radius: 20px;
    background: var(--surface);
    box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.06);
  }

  .hero-title-group { min-width: 0; }

  .hero-wordmark {
    display: block;
    margin-bottom: 8px;
    color: var(--subtle);
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .hero-heading-row {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 6px;
    flex-wrap: wrap;
  }

  .hero-title {
    font-family: 'Lora', Georgia, serif;
    font-size: clamp(1.4rem, 2.5vw, 1.75rem);
    font-weight: 600;
    line-height: 1.2;
    letter-spacing: -0.01em;
  }

  .admin-badge {
    display: inline-flex;
    align-items: center;
    padding: 4px 10px;
    border-radius: 999px;
    background: #18181b;
    color: #fafafa;
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    flex-shrink: 0;
  }

  .hero-subtitle { color: var(--muted); font-size: 0.9rem; }

  /* ── Tab nav ──────────────────────────────────────────────────────────── */

  .tab-nav {
    display: flex;
    gap: 6px;
    padding: 6px;
    border: 1px solid var(--border);
    border-radius: 16px;
    background: rgba(255,255,255,0.72);
    backdrop-filter: blur(8px);
    overflow-x: auto;
    scrollbar-width: none;
  }

  .tab-nav::-webkit-scrollbar { display: none; }

  .tab-btn {
    flex: 1;
    min-width: 80px;
    padding: 10px 16px;
    border: none;
    border-radius: 10px;
    background: transparent;
    color: var(--muted);
    font: 500 0.88rem/1.2 'DM Sans', sans-serif;
    cursor: pointer;
    white-space: nowrap;
    transition: background 140ms, color 140ms;
  }

  .tab-btn:hover { background: rgba(0,0,0,0.04); color: var(--text); }
  .tab-btn.active { background: var(--text); color: #fafafa; font-weight: 600; }
  .tab-btn:focus-visible { outline: 2px solid var(--text); outline-offset: 2px; }

  /* ── Tab panels ───────────────────────────────────────────────────────── */

  .tab-panel { display: none; flex-direction: column; gap: 14px; }
  .tab-panel.active { display: flex; }

  /* ── Cards ────────────────────────────────────────────────────────────── */

  .card {
    padding: 24px 28px;
    border: 1px solid var(--border);
    border-radius: 20px;
    background: var(--surface);
    box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.06);
  }

  .eyebrow {
    color: var(--subtle);
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    margin-bottom: 6px;
  }

  .card-title {
    font-family: 'Lora', Georgia, serif;
    font-size: clamp(1.1rem, 2vw, 1.3rem);
    font-weight: 600;
    line-height: 1.25;
    letter-spacing: -0.01em;
    margin-bottom: 10px;
  }

  .card-subtitle { font-size: 1rem; font-weight: 650; margin-bottom: 10px; line-height: 1.3; }
  .card-desc { color: var(--muted); font-size: 0.9rem; line-height: 1.55; }
  .card-desc-sm { color: var(--muted); font-size: 0.84rem; line-height: 1.5; }

  code {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 0.82em;
    padding: 0.14em 0.36em;
    border-radius: 6px;
    background: rgba(0,0,0,0.05);
    color: var(--text);
  }

  button:focus-visible { outline: 2px solid var(--text); outline-offset: 2px; }

  /* ── Overview ─────────────────────────────────────────────────────────── */

  .overview-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 14px;
  }

  .overview-card { padding: 20px 22px; }

  .stat-number {
    font-family: 'Lora', Georgia, serif;
    font-size: 2.4rem;
    font-weight: 600;
    line-height: 1;
    margin-bottom: 10px;
  }

  .overview-cmd-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }

  .overview-cmd-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 5px 10px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: rgba(0,0,0,0.025);
    color: var(--text);
    text-decoration: none;
    font-size: 0.78rem;
    font-weight: 500;
    transition: background 120ms;
    cursor: pointer;
  }

  .overview-cmd-chip:hover { background: rgba(0,0,0,0.06); }
  .overview-cmd-chip code { background: transparent; padding: 0; font-size: 0.78em; }

  .preset-logo-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }

  .overview-oauth-list { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; }

  .oauth-chip {
    display: inline-block;
    padding: 4px 10px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: rgba(0,0,0,0.025);
    font-size: 0.8rem;
    color: var(--muted);
  }

  /* ── Server status ────────────────────────────────────────────────────── */

  .status-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 10px;
    margin-top: 12px;
  }

  .status-item {
    padding: 14px 16px;
    border-radius: 14px;
    border: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .status-ok { background: var(--ok-bg); border-color: var(--ok-border); }
  .status-warn { background: var(--warn-bg); border-color: var(--warn-border); }

  .status-label {
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--subtle);
  }

  .status-value {
    font-size: 0.88rem;
    font-weight: 600;
    color: var(--text);
    word-break: break-all;
  }

  .status-ok .status-value { color: var(--ok-text); }
  .status-warn .status-value { color: var(--warn-text); }

  .status-note { font-size: 0.76rem; color: var(--warn-text); line-height: 1.4; }

  .status-action-btn {
    margin-top: 4px;
    padding: 4px 10px;
    border: none;
    border-radius: 999px;
    background: var(--text);
    color: #fff;
    font: 500 0.76rem/1.2 'DM Sans', sans-serif;
    cursor: pointer;
    width: fit-content;
    transition: opacity 140ms;
  }

  .status-action-btn:hover { opacity: 0.8; }

  /* ── Quick links ──────────────────────────────────────────────────────── */

  .quicklink-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 10px;
    margin-top: 12px;
  }

  .quicklink-btn {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    padding: 16px 18px;
    border: 1px solid var(--border);
    border-radius: 14px;
    background: rgba(0,0,0,0.02);
    cursor: pointer;
    text-align: left;
    transition: background 120ms, border-color 120ms, transform 120ms;
  }

  .quicklink-btn:hover {
    background: rgba(0,0,0,0.045);
    border-color: rgba(0,0,0,0.14);
    transform: translateY(-1px);
  }

  .quicklink-icon { font-size: 1.4rem; }
  .quicklink-label { font-weight: 650; font-size: 0.9rem; color: var(--text); }
  .quicklink-sub { font-size: 0.78rem; color: var(--muted); }

  /* ── Vaults section ───────────────────────────────────────────────────── */

  .section-intro { margin-bottom: 2px; }

  .section-intro-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
  }

  .refresh-btn {
    flex-shrink: 0;
    margin-top: 4px;
    padding: 8px 14px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: rgba(0,0,0,0.025);
    color: var(--muted);
    font: 500 0.84rem/1.2 'DM Sans', sans-serif;
    cursor: pointer;
    transition: background 120ms, color 120ms;
    white-space: nowrap;
  }

  .refresh-btn:hover { background: rgba(0,0,0,0.06); color: var(--text); }
  .refresh-btn:disabled { opacity: 0.5; cursor: wait; }

  .vault-row {
    padding: 16px 0;
    border-bottom: 1px solid rgba(0,0,0,0.06);
    transition: opacity 200ms, transform 200ms;
  }

  .vault-row:last-child { border-bottom: none; padding-bottom: 0; }
  .vault-row:first-child { padding-top: 0; }

  .vault-row-top {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 8px;
    flex-wrap: wrap;
  }

  .vault-row-info {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: 10px;
    flex-wrap: wrap;
  }

  .vault-name {
    font-weight: 650;
    font-size: 0.98rem;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    color: var(--text);
    word-break: break-all;
  }

  .vault-counts { font-size: 0.78rem; color: var(--subtle); flex-shrink: 0; }

  .vault-row-actions { display: flex; gap: 8px; flex-shrink: 0; }

  .vault-btn {
    padding: 7px 14px;
    border-radius: 8px;
    border: 1px solid var(--border);
    font: 500 0.82rem/1.2 'DM Sans', sans-serif;
    cursor: pointer;
    transition: background 120ms, border-color 120ms, opacity 120ms;
    white-space: nowrap;
  }

  .vault-btn:disabled { opacity: 0.5; cursor: wait; }

  .vault-btn-link {
    background: var(--text);
    color: #fff;
    border-color: transparent;
  }

  .vault-btn-link:hover:not(:disabled) { background: #2d2d30; }

  .vault-btn-delete {
    background: rgba(0,0,0,0.03);
    color: var(--err-text);
    border-color: rgba(185, 28, 28, 0.18);
  }

  .vault-btn-delete:hover:not(:disabled) {
    background: var(--err-bg);
    border-color: rgba(185, 28, 28, 0.28);
  }

  .vault-env-keys {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    min-height: 22px;
  }

  .env-key-chip {
    font-size: 0.74rem;
    padding: 3px 8px;
    border-radius: 6px;
    background: rgba(0,0,0,0.04);
    border: 1px solid rgba(0,0,0,0.07);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    color: var(--text);
  }

  .no-keys-msg { font-size: 0.8rem; color: var(--subtle); font-style: italic; }

  .vault-mounts {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin-top: 6px;
  }

  .mount-chip {
    font-size: 0.72rem;
    padding: 2px 8px;
    border-radius: 6px;
    background: rgba(59, 130, 246, 0.06);
    border: 1px solid rgba(59, 130, 246, 0.14);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    color: #1d4ed8;
  }

  .vault-link-result {
    margin-top: 10px;
    padding: 10px 14px;
    border-radius: 10px;
    font-size: 0.84rem;
  }

  .vault-link-result.ok {
    background: var(--ok-bg);
    border: 1px solid var(--ok-border);
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }

  .vault-link-result.err {
    background: var(--err-bg);
    border: 1px solid var(--err-border);
    color: var(--err-text);
  }

  .link-label { color: var(--ok-text); font-weight: 600; flex-shrink: 0; }

  .link-url {
    color: var(--ok-text);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 0.78rem;
    word-break: break-all;
    flex: 1;
    min-width: 0;
  }

  .copy-link-btn {
    padding: 5px 12px;
    border: 1px solid var(--ok-border);
    border-radius: 7px;
    background: rgba(255,255,255,0.7);
    color: var(--ok-text);
    font: 500 0.78rem/1.2 'DM Sans', sans-serif;
    cursor: pointer;
    flex-shrink: 0;
    transition: background 120ms;
  }

  .copy-link-btn:hover { background: #fff; }

  /* ── States ───────────────────────────────────────────────────────────── */

  .loading-msg { color: var(--muted); font-size: 0.9rem; padding: 8px 0; }

  .empty-state {
    padding: 24px 0;
    text-align: center;
    color: var(--muted);
    font-size: 0.9rem;
    line-height: 1.7;
  }

  .empty-state code { background: rgba(0,0,0,0.05); }

  .err-msg {
    padding: 12px 16px;
    border-radius: 10px;
    background: var(--err-bg);
    color: var(--err-text);
    border: 1px solid var(--err-border);
    font-size: 0.88rem;
  }

  .status-err-block {
    padding: 12px 16px;
    border-radius: 10px;
    background: var(--err-bg);
    color: var(--err-text);
    border: 1px solid var(--err-border);
    font-size: 0.9rem;
  }

  /* ── Command cards ────────────────────────────────────────────────────── */

  .cmd-list { display: flex; flex-direction: column; gap: 12px; }

  .cmd-card {
    padding: 22px 26px;
    border: 1px solid var(--border);
    border-radius: 20px;
    background: var(--surface);
    box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.06);
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .cmd-header { display: flex; align-items: flex-start; gap: 14px; }
  .cmd-icon { font-size: 1.4rem; flex-shrink: 0; margin-top: 2px; }
  .cmd-title-group { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }

  .cmd-name {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 1.1rem;
    font-weight: 600;
    background: transparent;
    padding: 0;
    color: var(--text);
  }

  .cmd-aliases { display: flex; flex-wrap: wrap; gap: 5px; }

  .alias-pill {
    font-size: 0.74rem;
    padding: 2px 8px;
    border-radius: 999px;
    background: rgba(0,0,0,0.04);
    border: 1px solid rgba(0,0,0,0.06);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    color: var(--muted);
  }

  .cmd-desc { color: var(--muted); font-size: 0.9rem; line-height: 1.55; }

  .cmd-note {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 10px 14px;
    border-radius: 10px;
    background: rgba(217, 119, 6, 0.07);
    border: 1px solid rgba(217, 119, 6, 0.16);
    color: #92400e;
    font-size: 0.84rem;
    line-height: 1.5;
  }

  .note-icon { flex-shrink: 0; }
  .cmd-usages { display: flex; flex-direction: column; gap: 2px; }

  .usage-heading {
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--subtle);
    margin-bottom: 6px;
  }

  .usage-row {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 12px 16px;
    align-items: baseline;
    padding: 8px 12px;
    border-radius: 10px;
    background: rgba(0,0,0,0.025);
    border: 1px solid rgba(0,0,0,0.04);
  }

  .usage-row + .usage-row { margin-top: 6px; }

  .usage-cmd {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 0.82rem;
    font-weight: 500;
    background: transparent;
    padding: 0;
    color: var(--text);
    white-space: nowrap;
  }

  .usage-desc { color: var(--muted); font-size: 0.84rem; line-height: 1.45; }

  .cmd-constraints {
    padding: 10px 14px;
    border-radius: 10px;
    background: rgba(0,0,0,0.025);
    border: 1px solid rgba(0,0,0,0.06);
  }

  .constraint-heading {
    display: block;
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--subtle);
    margin-bottom: 6px;
  }

  .cmd-constraints ul {
    padding-left: 16px;
    color: var(--muted);
    font-size: 0.84rem;
    line-height: 1.6;
  }

  /* ── Shared layout ────────────────────────────────────────────────────── */

  .two-col-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }

  .preset-list { display: flex; flex-direction: column; gap: 10px; margin-top: 12px; }

  .preset-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    border-radius: 12px;
    background: rgba(0,0,0,0.025);
    border: 1px solid rgba(0,0,0,0.06);
  }

  .preset-info { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .preset-label { font-size: 0.88rem; font-weight: 600; }

  .preset-envkeys {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 0.72rem;
    background: transparent;
    padding: 0;
    color: var(--muted);
  }

  /* ── Service logos ────────────────────────────────────────────────────── */

  .service-logo {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    border-radius: 9px;
    flex: 0 0 34px;
    background: #1c1e21;
    color: #fff;
  }

  .service-logo svg { display: block; width: 18px; height: 18px; }
  .service-logo-text { font-size: 10px; font-weight: 800; letter-spacing: 0.04em; text-transform: uppercase; }

  .service-logo.cloudflare { background: var(--service-cloudflare); }
  .service-logo.openai { background: var(--service-openai); }
  .service-logo.anthropic { background: var(--service-anthropic); }
  .service-logo.gemini { background: var(--service-gemini); }
  .service-logo.openrouter { background: var(--service-openrouter); }
  .service-logo.github { background: var(--service-github); }
  .service-logo.vercel { background: var(--service-vercel); }
  .service-logo.sentry { background: var(--service-sentry); }
  .service-logo.manual { background: var(--service-manual); }
  .service-logo.gws { background: var(--service-gws); }
  .service-logo.gcs { background: var(--service-gcs); }

  /* ── Flow steps ───────────────────────────────────────────────────────── */

  .flow-steps { list-style: none; display: flex; flex-direction: column; gap: 10px; margin-top: 12px; }

  .flow-steps li { display: flex; align-items: flex-start; gap: 12px; font-size: 0.9rem; line-height: 1.5; }

  .step-num {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: var(--text);
    color: #fff;
    font-size: 0.74rem;
    font-weight: 700;
    flex-shrink: 0;
    margin-top: 1px;
  }

  /* ── Feature list ─────────────────────────────────────────────────────── */

  .feature-list { list-style: none; display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }

  .feature-list li { display: flex; align-items: flex-start; gap: 10px; font-size: 0.88rem; color: var(--muted); line-height: 1.5; }

  .feature-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #22c55e;
    flex-shrink: 0;
    margin-top: 6px;
  }

  /* ── Code block list ──────────────────────────────────────────────────── */

  .code-block-list { display: flex; flex-direction: column; gap: 6px; margin-top: 12px; }

  .code-example {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 12px 16px;
    align-items: baseline;
    padding: 9px 12px;
    border-radius: 10px;
    background: rgba(0,0,0,0.025);
    border: 1px solid rgba(0,0,0,0.05);
    font-size: 0.84rem;
  }

  .code-example span { color: var(--muted); }

  /* ── Inline tab button ────────────────────────────────────────────────── */

  .inline-tab-btn {
    display: inline;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--text);
    font: inherit;
    font-weight: 650;
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
  }

  /* ── Responsive ───────────────────────────────────────────────────────── */

  @media (max-width: 640px) {
    body { padding: 16px 12px 48px; }
    .shell { gap: 12px; }
    .hero-card, .card { padding: 18px; border-radius: 16px; }
    .cmd-card { padding: 18px; border-radius: 16px; }
    .two-col-grid { grid-template-columns: 1fr; }
    .overview-grid { grid-template-columns: 1fr 1fr; }
    .tab-btn { padding: 9px 12px; font-size: 0.82rem; min-width: 60px; }
    .usage-row { grid-template-columns: 1fr; gap: 4px; }
    .code-example { grid-template-columns: 1fr; gap: 4px; }
    .quicklink-grid { grid-template-columns: 1fr 1fr; }
    .status-grid { grid-template-columns: 1fr 1fr; }
    .section-intro-header { flex-direction: column; gap: 10px; }
    .vault-row-top { flex-direction: column; align-items: flex-start; }
    .vault-row-actions { width: 100%; }
    .vault-btn { flex: 1; }
  }

  @media (max-width: 400px) {
    .overview-grid { grid-template-columns: 1fr; }
    .quicklink-grid { grid-template-columns: 1fr; }
    .status-grid { grid-template-columns: 1fr; }
  }
`;
