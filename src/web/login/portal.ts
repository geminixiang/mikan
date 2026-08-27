import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { escapeHtml, readJsonBody, renderPortalShell, requestBaseUrl } from "../portal-shell.js";
import { resolveLinkBaseUrl } from "../../config.js";
import { readEnv } from "../../env-manifest.js";
import type { PlatformName } from "../../adapter.js";
import { InMemoryTokenStore } from "../token-store.js";
import type { LinkToken } from "./types.js";
export type { LinkToken } from "./types.js";
import {
  getOAuthServices,
  resolveOAuthService,
  type LoginCredentialKind,
  type OAuthService,
} from "./oauth.js";
import * as log from "../../log.js";
import { reportUserFacingError } from "../../observability/sentry.js";
import { PRODUCT_NAME } from "../../platform-messages.js";
import { defaultVaultTargetPath, type VaultManager } from "../../vault/index.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export type { NotifyFn } from "./types.js";

const TTL_MS = 15 * 60 * 1000;

export class InMemoryLinkTokenStore extends InMemoryTokenStore<LinkToken> {
  create(
    platform: PlatformName,
    platformUserId: string,
    conversationId: string,
    vaultId: string,
    providerId: string,
  ): LinkToken {
    this.deleteWhere(
      (token) => token.platform === platform && token.platformUserId === platformUserId,
    );
    return this.createRecord(TTL_MS, {
      platform,
      platformUserId,
      vaultId,
      providerId,
      conversationId,
    });
  }
}
import type { NotifyFn } from "./types.js";

interface LinkCompleteBody {
  token: string;
  mode?: LoginCredentialKind;
  envKey?: string;
  credential?: string;
  env?: Record<string, string>;
}

interface OAuthStartBody {
  token: string;
  serviceId: string;
}

interface PendingOAuthState {
  linkToken: string;
  serviceId: string;
  codeVerifier: string;
  expiresAt: number;
}

interface SecretPresetField {
  envKey: string;
  envKeys?: string[];
  label: string;
  type: "text" | "password";
  placeholder: string;
  helpText: string;
  optional?: boolean;
  pattern?: string;
  patternMessage?: string;
}

interface SecretPreset {
  id: string;
  label: string;
  description: string;
  note?: string;
  fields: SecretPresetField[];
}

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_SECRET_CONFIG_ID = "manual";
const SECRET_PRESETS: SecretPreset[] = [
  {
    id: "cloudflare_wrangler",
    label: "Cloudflare / Wrangler",
    description:
      "Store a Cloudflare API token and account ID for Wrangler, Workers, Pages, D1, and KV.",
    note: "Create a scoped API Token from Cloudflare Dashboard → My Profile → API Tokens. Do not use the Global API Key.",
    fields: [
      {
        envKey: "CLOUDFLARE_API_TOKEN",
        label: "Cloudflare API Token",
        type: "password",
        placeholder: "cfut_...",
        helpText: "Recommended for Wrangler, CI, and sandbox use.",
      },
      {
        envKey: "CLOUDFLARE_ACCOUNT_ID",
        label: "Cloudflare Account ID",
        type: "text",
        placeholder: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        helpText: "Find this via wrangler whoami or in the Cloudflare dashboard account page.",
        pattern: "^[A-Fa-f0-9]{32}$",
        patternMessage: "Account ID must be a 32-character hexadecimal string.",
      },
    ],
  },
  {
    id: "openai",
    label: "OpenAI",
    description: "Store an OpenAI API key for tools and SDKs that use OPENAI_API_KEY.",
    note: "Create a standard API key from the OpenAI dashboard. Paste the key exactly as issued.",
    fields: [
      {
        envKey: "OPENAI_API_KEY",
        label: "OpenAI API Key",
        type: "password",
        placeholder: "sk-...",
        helpText: "Used by the OpenAI SDK, CLI wrappers, and many coding tools.",
      },
    ],
  },
  {
    id: "anthropic",
    label: "Anthropic",
    description: "Store an Anthropic API key for Claude and tools that use ANTHROPIC_API_KEY.",
    note: "Create this key from the Anthropic Console. Use a workspace-scoped key when possible.",
    fields: [
      {
        envKey: "ANTHROPIC_API_KEY",
        label: "Anthropic API Key",
        type: "password",
        placeholder: "sk-ant-...",
        helpText: "Used by Claude integrations and Anthropic-compatible tooling.",
      },
    ],
  },
  {
    id: "gemini",
    label: "Gemini",
    description:
      "Store one Google AI Studio key and expose it as both GEMINI_API_KEY and GOOGLE_API_KEY.",
    note: "Create a Gemini / Google AI Studio API key, then paste it once here for compatibility with both env names.",
    fields: [
      {
        envKey: "GEMINI_API_KEY",
        envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
        label: "Gemini API Key",
        type: "password",
        placeholder: "AIza...",
        helpText: "One value will be written to both GEMINI_API_KEY and GOOGLE_API_KEY.",
      },
    ],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    description: "Store an OpenRouter API key for tools that route models through OpenRouter.",
    note: "Create a key from the OpenRouter dashboard and paste it here.",
    fields: [
      {
        envKey: "OPENROUTER_API_KEY",
        label: "OpenRouter API Key",
        type: "password",
        placeholder: "sk-or-v1-...",
        helpText: "Used by OpenRouter SDKs and compatible model gateways.",
      },
    ],
  },
  {
    id: "github_pat",
    label: "GitHub PAT",
    description:
      "Store one GitHub personal access token and expose it as both GH_TOKEN and GITHUB_TOKEN.",
    note: "Create a fine-grained or classic personal access token from GitHub Settings → Developer settings.",
    fields: [
      {
        envKey: "GH_TOKEN",
        envKeys: ["GH_TOKEN", "GITHUB_TOKEN"],
        label: "GitHub Personal Access Token",
        type: "password",
        placeholder: "github_pat_...",
        helpText: "One value will be written to both GH_TOKEN and GITHUB_TOKEN.",
      },
    ],
  },
  {
    id: "vercel",
    label: "Vercel",
    description: "Store a Vercel token plus optional org and project IDs for deployment tooling.",
    note: "Create a token from the Vercel dashboard. Org ID and Project ID are optional but useful for scripted deploys.",
    fields: [
      {
        envKey: "VERCEL_TOKEN",
        label: "Vercel Token",
        type: "password",
        placeholder: "vercel_...",
        helpText: "Required for Vercel CLI and API access.",
      },
      {
        envKey: "VERCEL_ORG_ID",
        label: "Vercel Org ID",
        type: "text",
        placeholder: "team_...",
        helpText: "Optional. Set this when you want to target a specific team or account.",
        optional: true,
      },
      {
        envKey: "VERCEL_PROJECT_ID",
        label: "Vercel Project ID",
        type: "text",
        placeholder: "prj_...",
        helpText: "Optional. Set this when deploy scripts need a fixed project reference.",
        optional: true,
      },
    ],
  },
  {
    id: "sentry",
    label: "Sentry",
    description:
      "Store a Sentry auth token plus optional org/project, and mount ~/.sentryclirc for sentry-cli.",
    note: "Create an auth token from Sentry Settings → Account → API → Auth Tokens. Saving this preset also writes /root/.sentryclirc for sentry-cli.",
    fields: [
      {
        envKey: "SENTRY_AUTH_TOKEN",
        label: "Sentry Auth Token",
        type: "password",
        placeholder: "sntrys_...",
        helpText:
          "Required for Sentry CLI, releases, and sourcemap uploads. Also written to /root/.sentryclirc.",
      },
      {
        envKey: "SENTRY_ORG",
        label: "Sentry Org Slug",
        type: "text",
        placeholder: "my-org",
        helpText: "Optional. Helpful for Sentry CLI commands and CI automation.",
        optional: true,
      },
      {
        envKey: "SENTRY_PROJECT",
        label: "Sentry Project Slug",
        type: "text",
        placeholder: "my-project",
        helpText: "Optional. Helpful for release and sourcemap commands.",
        optional: true,
      },
    ],
  },
];

// ── request handler ───────────────────────────────────────────────────────────

/**
 * Start a small HTTP server that receives credential onboarding callbacks from the web portal.
 *
 * Routes:
 *   GET  /health              — health check
 *   GET  /link?token=xxx      — credential onboarding page
 *   POST /api/link/complete   — API key completion endpoint
 *   POST /api/oauth/start     — creates provider OAuth redirect URL
 *   GET  /oauth/callback      — OAuth callback endpoint
 */
export function createLoginRequestHandler(
  linkTokenStore: InMemoryLinkTokenStore,
  vaultManager: VaultManager,
  notify: NotifyFn,
): (req: IncomingMessage, res: ServerResponse, url: URL) => boolean {
  const oauthStates = new Map<string, PendingOAuthState>();

  return (req, res, url) => {
    if (req.method === "GET" && url.pathname === "/link") {
      const rawToken = url.searchParams.get("token") ?? "";
      const linkToken = linkTokenStore.peek(rawToken);

      if (!linkToken) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          renderErrorPage(
            "This link is invalid or has expired. Ask the bot for a new /login link.",
          ),
        );
        return true;
      }

      const oauthServiceHint = linkToken.providerId
        ? resolveOAuthService(linkToken.providerId)
        : undefined;
      const oauthServices = getOAuthServices();
      const defaultMode: LoginCredentialKind = oauthServiceHint ? "oauth" : "api_key";
      const existingSecrets = describeVaultSecrets(vaultManager, linkToken.vaultId);

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        renderCredentialPage(
          rawToken,
          oauthServiceHint ? `${oauthServiceHint.label} OAuth` : "Store Secret",
          defaultMode,
          "",
          "Secret value",
          "sk-...",
          oauthServiceHint
            ? `Authorize ${oauthServiceHint.label} and store tokens in your vault.`
            : "Set any environment variable key/value pair in your vault.",
          oauthServices,
          oauthServiceHint?.id,
          existingSecrets,
        ),
      );
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/link/complete") {
      if (!enforceCsrf(req, res)) return true;
      void readJsonBody(req, res, 16 * 1024).then((body) => {
        if (body === null) return;
        return handleLinkComplete(
          body as Partial<LinkCompleteBody>,
          linkTokenStore,
          vaultManager,
          notify,
          res,
        );
      });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/oauth/start") {
      if (!enforceCsrf(req, res)) return true;
      void readJsonBody(req, res, 16 * 1024).then((body) => {
        if (body === null) return;
        return handleOAuthStart(
          body as Partial<OAuthStartBody>,
          req,
          linkTokenStore,
          oauthStates,
          res,
        );
      });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/oauth/callback") {
      void handleOAuthCallback(
        url,
        req,
        linkTokenStore,
        vaultManager,
        notify,
        oauthStates,
        res,
      ).catch((err: Error) => {
        log.logWarning("OAuth callback failed", err.message);
        reportUserFacingError(err, {
          domain: "login",
          surface: "oauth",
          operation: "oauth_callback",
          severity: "error",
          context: { route: "/oauth/callback" },
        });
        res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderErrorPage("OAuth callback failed. Please retry /login."));
      });
      return true;
    }

    return false;
  };
}

/**
 * Block cross-site POSTs to the credential endpoints. Two defenses:
 *   1. Require Content-Type: application/json, which forces a CORS preflight
 *      for any cross-origin fetch and rules out `<form enctype="text/plain">`
 *      tricks that could otherwise smuggle a JSON body.
 *   2. When MIKAN_LINK_URL is configured, require that the Origin (or Referer,
 *      as a fallback for browsers that strip Origin) matches that base URL.
 *      This stops an attacker-controlled page — even one that somehow stole a
 *      victim's link token — from completing the flow.
 */
function enforceCsrf(req: IncomingMessage, res: ServerResponse): boolean {
  const contentType = (req.headers["content-type"] as string | undefined)
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    res.writeHead(415, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Content-Type must be application/json" }));
    return false;
  }

  const configured = resolveLinkBaseUrl();
  if (!configured) {
    // No trusted origin to compare against in local/dev mode; the loopback
    // bind already prevents cross-host access.
    return true;
  }

  let configuredOrigin: string;
  try {
    configuredOrigin = new URL(configured).origin;
  } catch {
    // Misconfigured MIKAN_LINK_URL — fail closed.
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Server misconfiguration" }));
    return false;
  }

  if (requestOrigin(req) !== configuredOrigin) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Cross-origin request rejected" }));
    return false;
  }

  return true;
}

/** Best-effort origin of the request, derived from Origin or Referer. */
function requestOrigin(req: IncomingMessage): string | undefined {
  const origin = (req.headers.origin as string | undefined)?.trim();
  if (origin && origin !== "null") return origin;

  const referer = (req.headers.referer as string | undefined)?.trim();
  if (!referer) return undefined;
  try {
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
}

// ── HTML helpers ───────────────────────────────────────────────────────────────

const esc = escapeHtml;

const loginViewStyles = `
  /* Login portal inherits all base chrome from the shared shell.
     This module only adds preset cards, service logos, help popovers,
     and the mode toggle. */

  p { margin: 0; color: var(--muted); font-size: 0.92rem; line-height: 1.55; }

  .stack > * + * { margin-top: 14px; }

  label {
    display: block;
    margin-bottom: 6px;
    font-size: 0.86rem;
    font-weight: 600;
    color: var(--text);
  }

  input, select {
    width: 100%;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: #fff;
    color: var(--text);
    font: inherit;
  }

  input:focus-visible,
  select:focus-visible {
    outline: 2px solid var(--text);
    outline-offset: 1px;
  }

  .primary-button {
    width: 100%;
    padding: 12px 18px;
    border: none;
    border-radius: 12px;
    background: var(--text);
    color: #fff;
    cursor: pointer;
    font: 500 0.95rem/1.2 'DM Sans', sans-serif;
    transition: opacity 120ms;
  }

  .primary-button:hover:not(:disabled) { opacity: 0.85; }
  .primary-button:disabled { opacity: 0.5; cursor: default; }

  .service-logo {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border-radius: 10px;
    flex: 0 0 36px;
    background: #1c1e21;
    color: #fff;
  }

  .service-logo svg {
    display: block;
    width: 20px;
    height: 20px;
  }

  .service-logo-text {
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .service-logo.cloudflare {
    background: linear-gradient(180deg, #ffb66d 0%, #f48120 100%);
  }

  .service-logo.openai {
    background: linear-gradient(180deg, #3e4045 0%, #111315 100%);
  }

  .service-logo.anthropic {
    background: linear-gradient(180deg, #d6b48c 0%, #9a6d3a 100%);
  }

  .service-logo.gemini {
    background: linear-gradient(180deg, #8ab4ff 0%, #5b6cff 100%);
  }

  .service-logo.openrouter {
    background: linear-gradient(180deg, #8c8cff 0%, #4f46e5 100%);
  }

  .service-logo.github {
    background: linear-gradient(180deg, #4a4f57 0%, #1b1f23 100%);
  }

  .service-logo.vercel {
    background: linear-gradient(180deg, #4a4f57 0%, #000 100%);
  }

  .service-logo.sentry {
    background: linear-gradient(180deg, #7c5cff 0%, #3f2e8c 100%);
  }

  .service-logo.manual {
    background: linear-gradient(180deg, #43474d 0%, #1c1e21 100%);
  }

  .provider-card > * + * {
    margin-top: 14px;
  }

  .provider-header {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .provider-title {
    flex: 1;
    margin: 0;
    font-size: 1rem;
    font-weight: 650;
    line-height: 1.3;
  }

  .provider-field label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .help {
    position: relative;
    display: inline-flex;
    align-items: center;
  }

  .help-trigger {
    width: 18px;
    height: 18px;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.9);
    color: var(--muted);
    font-size: 11px;
    font-weight: 700;
    line-height: 1;
    cursor: pointer;
  }

  .help-trigger:hover {
    color: var(--text);
    border-color: var(--text);
  }

  .help-content {
    display: none;
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 10;
    width: max-content;
    max-width: 280px;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: #fff;
    color: var(--text);
    font-size: 0.85rem;
    font-weight: 400;
    line-height: 1.45;
    box-shadow: 0 8px 24px rgba(28, 30, 33, 0.12);
    white-space: normal;
  }

  .help-trigger[aria-expanded="true"] + .help-content {
    display: block;
  }

  .help-trigger[aria-expanded="true"] {
    color: var(--text);
    border-color: var(--text);
  }

  .mode {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 22px;
  }

  .mode label {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.85);
    font-weight: 500;
  }

  .mode input {
    width: auto;
    margin: 0;
  }

  .panel {
    display: none;
  }

  .panel.active {
    display: block;
  }

  #api-panel.active {
    display: grid;
    gap: 16px;
  }

  .panel-note {
    margin-top: 10px;
    font-size: 0.92rem;
  }

  .result,
  .status {
    margin-top: 20px;
    padding: 14px 16px;
    border-radius: 14px;
    font-size: 0.95rem;
  }

  .result {
    display: none;
  }

  .result.ok,
  .status.ok {
    background: var(--ok-bg);
    color: var(--ok-text);
  }

  .result.err,
  .status.err {
    background: var(--err-bg);
    color: var(--err-text);
  }

  .secrets-summary {
    margin-top: 18px;
    padding: 14px 16px;
    border: 1px solid var(--border);
    border-radius: 14px;
    background: rgba(255, 255, 255, 0.72);
  }

  .secrets-summary h2 {
    margin: 0 0 8px;
    font-size: 0.98rem;
  }

  .secrets-summary p {
    font-size: 0.92rem;
  }

  .secrets-summary ul {
    margin: 10px 0 0;
    padding-left: 18px;
    color: var(--text);
  }

  .secrets-summary li + li {
    margin-top: 6px;
  }

  .close-note {
    margin-top: 14px;
    font-size: 0.92rem;
  }

  @media (max-width: 640px) {
    .mode label { flex: 1; justify-content: center; }
    input, select { padding: 12px; }
    .primary-button { padding: 14px 18px; }
    .help-content { max-width: min(260px, calc(100vw - 40px)); }
    .provider-header .help-content { left: auto; right: 0; }
  }
`;

function renderHtmlDocument(title: string, shellContent: string): string {
  return renderPortalShell({
    activeView: "vault",
    pageTitle: "Vault",
    body: shellContent,
    extraStyles: loginViewStyles,
  });
}

function renderStatusPage(
  title: string,
  message: string,
  tone: "ok" | "err",
  options?: { closeNote?: boolean },
): string {
  const closeNote = options?.closeNote ? '<p class="close-note">You can close this tab.</p>' : "";
  return renderHtmlDocument(
    title,
    `<section class="card"><div class="stack">
      <p class="eyebrow">${PRODUCT_NAME}</p>
      <h1 class="page-title">${esc(title)}</h1>
      <div class="status ${tone}">${esc(message)}</div>
      ${closeNote}
    </div></section>`,
  );
}

interface ExistingSecretsSummary {
  envKeys: string[];
  mountTargets: string[];
}

function describeVaultSecrets(vaultManager: VaultManager, vaultId: string): ExistingSecretsSummary {
  const vault = vaultManager.resolve(vaultId);
  if (!vault) {
    return { envKeys: [], mountTargets: [] };
  }

  return {
    envKeys: Object.keys(vault.env).toSorted((left, right) => left.localeCompare(right)),
    mountTargets: [...new Set(vault.mounts.map((mount) => mount.target))].toSorted((left, right) =>
      left.localeCompare(right),
    ),
  };
}

function renderSecretsSummary(summary: ExistingSecretsSummary): string {
  if (summary.envKeys.length === 0 && summary.mountTargets.length === 0) {
    return `
  <section class="secrets-summary">
    <h2>Currently stored</h2>
    <p>No secrets are stored in this vault yet.</p>
  </section>`;
  }

  const envItems = summary.envKeys.map((envKey) => `<li><code>${esc(envKey)}</code></li>`).join("");
  const mountItems = summary.mountTargets
    .map((target) => `<li><code>${esc(target)}</code></li>`)
    .join("");

  return `
  <section class="secrets-summary">
    <h2>Currently stored</h2>
    <p>Only secret names and mounted paths are shown here. Secret values are never displayed.</p>
    ${summary.envKeys.length > 0 ? `<p><strong>Environment keys</strong></p><ul>${envItems}</ul>` : ""}
    ${summary.mountTargets.length > 0 ? `<p><strong>Mounted secret files</strong></p><ul>${mountItems}</ul>` : ""}
  </section>`;
}

function renderServiceLogo(kind: string): string {
  if (kind === "cloudflare_wrangler") {
    return `<span class="service-logo cloudflare" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none">
        <path d="M8.5 17.5h8.2a2.9 2.9 0 0 0 .4-5.78A4.45 4.45 0 0 0 8.9 10.4a3.7 3.7 0 0 0-.4 7.1Z" fill="white" fill-opacity="0.98"/>
        <path d="M6.6 17.5h5.1a2.3 2.3 0 0 0 0-4.6 3.1 3.1 0 0 0-3-2.2 3.23 3.23 0 0 0-3.18 3.64A2.67 2.67 0 0 0 6.6 17.5Z" fill="white"/>
      </svg>
    </span>`;
  }

  const textLogos: Record<string, { className: string; text: string }> = {
    openai: { className: "openai", text: "OA" },
    anthropic: { className: "anthropic", text: "AI" },
    gemini: { className: "gemini", text: "G" },
    openrouter: { className: "openrouter", text: "OR" },
    github_pat: { className: "github", text: "GH" },
    vercel: { className: "vercel", text: "V" },
    sentry: { className: "sentry", text: "S" },
    manual: { className: "manual", text: ">_" },
  };
  const logo = textLogos[kind] ?? textLogos.manual ?? { className: "manual", text: ">_" };
  return `<span class="service-logo ${logo.className}" aria-hidden="true"><span class="service-logo-text">${logo.text}</span></span>`;
}

function resolveFieldEnvKeys(field: SecretPresetField): string[] {
  return field.envKeys && field.envKeys.length > 0 ? field.envKeys : [field.envKey];
}

function renderStoredEnvKeysInline(field: SecretPresetField): string {
  return resolveFieldEnvKeys(field)
    .map((envKey) => `<code>${esc(envKey)}</code>`)
    .join(", ");
}

function renderHelpIcon(html: string): string {
  return `<span class="help">
    <button type="button" class="help-trigger" aria-label="More info" aria-expanded="false">?</button>
    <span class="help-content" role="tooltip">${html}</span>
  </span>`;
}

function renderPresetProviderCard(preset: SecretPreset): string {
  const headerHelp = preset.note ? renderHelpIcon(esc(preset.note)) : "";
  const fields = preset.fields
    .map((field) => {
      const storedKeys = renderStoredEnvKeysInline(field);
      const helpText = `${esc(field.helpText)} Stored as ${storedKeys}.${field.optional ? " Optional." : ""}`;
      return `<div class="provider-field">
        <label for="preset-${esc(preset.id)}-${esc(field.envKey)}">
          ${esc(field.label)}
          ${renderHelpIcon(helpText)}
        </label>
        <input
          id="preset-${esc(preset.id)}-${esc(field.envKey)}"
          type="${field.type}"
          autocomplete="off"
          placeholder="${esc(field.placeholder)}"
          data-env-key="${esc(field.envKey)}"
          data-env-keys="${esc(resolveFieldEnvKeys(field).join(","))}"
          data-field-label="${esc(field.label)}"
          ${field.optional ? 'data-optional="true"' : ""}
          ${field.pattern ? `data-pattern="${esc(field.pattern)}"` : ""}
          ${field.patternMessage ? `data-pattern-message="${esc(field.patternMessage)}"` : ""}
        >
      </div>`;
    })
    .join("\n");

  return `<section class="card provider-card" data-provider-kind="preset" data-provider-id="${esc(preset.id)}">
    <div class="provider-header">
      ${renderServiceLogo(preset.id)}
      <h2 class="provider-title">${esc(preset.label)}</h2>
      ${headerHelp}
    </div>
    ${fields}
  </section>`;
}

function renderManualProviderCard(
  initialEnvKey: string,
  secretLabel: string,
  placeholder: string,
): string {
  const headerHelp = renderHelpIcon(
    esc(
      "Set any environment variable key/value pair manually. Use this when no provider preset fits.",
    ),
  );
  return `<section class="card provider-card" data-provider-kind="manual" data-provider-id="${esc(DEFAULT_SECRET_CONFIG_ID)}">
    <div class="provider-header">
      ${renderServiceLogo("manual")}
      <h2 class="provider-title">Manual entry</h2>
      ${headerHelp}
    </div>
    <div class="provider-field">
      <label for="envKey">Environment key</label>
      <input id="envKey" type="text" name="envKey" placeholder="OPENAI_API_KEY" value="${esc(initialEnvKey)}" autocomplete="off">
    </div>
    <div class="provider-field">
      <label for="credential">${esc(secretLabel)}</label>
      <input id="credential" type="password" name="credential" placeholder="${esc(placeholder)}" autocomplete="off">
    </div>
  </section>`;
}

function renderCredentialPage(
  token: string,
  title: string,
  defaultMode: LoginCredentialKind,
  initialEnvKey: string,
  secretLabel: string,
  placeholder: string,
  helpText: string,
  oauthServices: OAuthService[],
  oauthServiceIdHint: string | undefined,
  existingSecrets: ExistingSecretsSummary,
): string {
  const oauthOptions = oauthServices
    .map((service) => {
      const selected = service.id === oauthServiceIdHint ? ' selected="selected"' : "";
      return `<option value="${esc(service.id)}"${selected}>${esc(service.label)}</option>`;
    })
    .join("\n");
  const presetCards = SECRET_PRESETS.map(renderPresetProviderCard).join("\n");

  return renderHtmlDocument(
    "Login",
    `<section class="card stack">
  <p class="eyebrow">${PRODUCT_NAME}</p>
  <h1 class="page-title">${esc(title)}</h1>
  <p>Your personal sandbox is already provisioned automatically.</p>
  <p>${esc(helpText)}</p>
  ${renderSecretsSummary(existingSecrets)}
  <div class="mode">
    <label><input type="radio" name="mode" value="api_key" ${defaultMode === "api_key" ? "checked" : ""}> Secrets / API tokens</label>
    <label><input type="radio" name="mode" value="oauth" ${defaultMode === "oauth" ? "checked" : ""}> OAuth login</label>
  </div>
</section>

<div id="api-panel" class="panel">
  ${presetCards}
  ${renderManualProviderCard(initialEnvKey, secretLabel, placeholder)}
</div>

<div id="oauth-panel" class="panel card stack">
  <label for="oauthService">OAuth service</label>
  <select id="oauthService" name="oauthService">${oauthOptions}</select>
  <p class="panel-note">You'll be redirected to the selected service's authorization page.</p>
</div>

<div>
  <button id="btn" class="primary-button" onclick="connect()">Continue</button>
  <div id="result" class="result" aria-live="polite"></div>
</div>
  <script>
    const envKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

    function selectedMode() {
      return document.querySelector('input[name="mode"]:checked').value;
    }

    function showResult(message, ok) {
      const result = document.getElementById('result');
      result.style.display = 'block';
      result.className = ok ? 'result ok' : 'result err';
      result.textContent = message;
    }

    function resetContinueButton() {
      const btn = document.getElementById('btn');
      btn.disabled = false;
      btn.textContent = 'Continue';
    }

    function syncPanels() {
      const mode = selectedMode();
      document.getElementById('api-panel').classList.toggle('active', mode === 'api_key');
      document.getElementById('oauth-panel').classList.toggle('active', mode === 'oauth');
    }

    function collectManualCard(card) {
      const envKey = card.querySelector('#envKey').value.trim();
      const credential = card.querySelector('#credential').value.trim();
      if (!envKey && !credential) return { skip: true };
      if (!envKeyPattern.test(envKey)) return { error: 'Manual entry: please enter a valid environment key.' };
      if (!credential) return { error: 'Manual entry: please enter a secret value.' };
      return { env: { [envKey]: credential } };
    }

    function collectPresetCard(card) {
      const inputs = card.querySelectorAll('input[data-env-key]');
      const filled = Array.from(inputs).some((input) => input.value.trim() !== '');
      if (!filled) return { skip: true };

      const env = {};
      for (const input of inputs) {
        const value = input.value.trim();
        const label = input.dataset.fieldLabel || input.dataset.envKey || 'a value';
        const optional = input.dataset.optional === 'true';
        if (!value) {
          if (optional) continue;
          return { error: 'Please enter ' + label + '.' };
        }
        if (input.dataset.pattern && !(new RegExp(input.dataset.pattern).test(value))) {
          return { error: input.dataset.patternMessage || ('Invalid ' + label + '.') };
        }
        const envKeys = (input.dataset.envKeys || input.dataset.envKey || '')
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean);
        for (const envKey of envKeys) {
          env[envKey] = value;
        }
      }
      return { env };
    }

    function collectApiEnv() {
      const env = {};
      let any = false;
      for (const card of document.querySelectorAll('.provider-card')) {
        const result = card.dataset.providerKind === 'manual'
          ? collectManualCard(card)
          : collectPresetCard(card);
        if (result.skip) continue;
        if (result.error) return { error: result.error };
        Object.assign(env, result.env);
        any = true;
      }
      if (!any) return { error: 'Fill in at least one provider before continuing.' };
      return { env };
    }

    async function startOAuthFlow() {
      const serviceId = document.getElementById('oauthService').value;
      const r = await fetch('/api/oauth/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: '${esc(token)}', serviceId }),
      });
      const data = await r.json();
      if (!r.ok) {
        showResult('Error: ' + (data.error ?? r.status), false);
        resetContinueButton();
        return;
      }
      window.location.href = data.redirectUrl;
    }

    async function saveApiSecrets() {
      const payload = collectApiEnv();
      if (payload.error) {
        showResult(payload.error, false);
        resetContinueButton();
        return;
      }

      const r = await fetch('/api/link/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: '${esc(token)}', mode: 'api_key', env: payload.env }),
      });
      const data = await r.json();
      if (r.ok) {
        showResult(data.message ?? 'Credential stored. You can close this tab.', true);
        document.getElementById('btn').style.display = 'none';
        for (const input of document.querySelectorAll('input,select,button')) input.disabled = true;
      } else {
        showResult('Error: ' + (data.error ?? r.status), false);
        resetContinueButton();
      }
    }

    let openHelp = null;
    function closeOpenHelp() {
      if (openHelp) {
        openHelp.setAttribute('aria-expanded', 'false');
        openHelp = null;
      }
    }

    for (const trigger of document.querySelectorAll('.help-trigger')) {
      trigger.addEventListener('click', (event) => {
        event.stopPropagation();
        const wasOpen = trigger.getAttribute('aria-expanded') === 'true';
        closeOpenHelp();
        if (!wasOpen) {
          trigger.setAttribute('aria-expanded', 'true');
          openHelp = trigger;
        }
      });
    }

    document.addEventListener('click', closeOpenHelp);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeOpenHelp();
    });

    for (const radio of document.querySelectorAll('input[name="mode"]')) {
      radio.addEventListener('change', syncPanels);
    }

    syncPanels();

    async function connect() {
      const btn = document.getElementById('btn');
      const mode = selectedMode();
      btn.disabled = true;
      btn.textContent = mode === 'oauth' ? 'Redirecting…' : 'Saving…';

      try {
        if (mode === 'oauth') {
          await startOAuthFlow();
          return;
        }
        await saveApiSecrets();
      } catch (err) {
        showResult('Network error: ' + (err?.message ?? err), false);
        resetContinueButton();
      }
    }
  </script>`,
  );
}

function renderErrorPage(message: string): string {
  return renderStatusPage("Login Error", message, "err");
}

function renderSuccessPage(message: string): string {
  return renderStatusPage("Connected", message, "ok", { closeNote: true });
}

function isValidEnvKey(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function extractEnvUpdates(data: Partial<LinkCompleteBody>): {
  updates?: Record<string, string>;
  error?: string;
} {
  if (data.env && typeof data.env === "object" && !Array.isArray(data.env)) {
    const rawEntries = Object.entries(data.env);
    if (rawEntries.length === 0) return { error: "Missing required field: env" };

    const updates: Record<string, string> = {};
    for (const [rawKey, rawValue] of rawEntries) {
      const envKey = rawKey.trim();
      const credential = typeof rawValue === "string" ? rawValue.trim() : "";
      if (!isValidEnvKey(envKey)) return { error: `Invalid envKey format: ${rawKey}` };
      if (!credential) return { error: `Missing value for envKey: ${envKey}` };
      updates[envKey] = credential;
    }

    return { updates };
  }

  const envKey = data.envKey?.trim() ?? "";
  const credential = data.credential?.trim() ?? "";
  if (!isValidEnvKey(envKey)) return { error: "Invalid envKey format" };
  if (!credential) return { error: "Missing required field: credential" };
  return { updates: { [envKey]: credential } };
}

function renderStoredEnvMessage(envKeys: string[], fileTargets: string[] = []): string {
  const fileSuffix = fileTargets.length > 0 ? ` Mounted file(s): ${fileTargets.join(", ")}.` : "";
  if (envKeys.length === 1) {
    return `${envKeys[0]} stored successfully in vault.${fileSuffix}`;
  }

  return `${envKeys.length} secrets stored successfully in vault: ${envKeys.join(", ")}.${fileSuffix}`;
}

function renderSentryCliConfig(updates: Record<string, string>): string | undefined {
  const token = updates.SENTRY_AUTH_TOKEN?.trim();
  if (!token) return undefined;

  const lines = ["[auth]", `token=${token}`, ""];
  const defaults: string[] = [];
  const org = updates.SENTRY_ORG?.trim();
  const project = updates.SENTRY_PROJECT?.trim();
  if (org) defaults.push(`org = ${org}`);
  if (project) defaults.push(`project = ${project}`);
  if (defaults.length > 0) {
    lines.push("[defaults]", ...defaults, "");
  }
  return lines.join("\n");
}

// ── API-key completion ────────────────────────────────────────────────────────

async function handleLinkComplete(
  data: Partial<LinkCompleteBody>,
  linkTokenStore: InMemoryLinkTokenStore,
  vaultManager: VaultManager,
  notify: NotifyFn,
  res: ServerResponse,
): Promise<void> {
  if (!data.token) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing required field: token" }));
    return;
  }

  const { updates, error } = extractEnvUpdates(data);
  if (!updates || error) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: error ?? "Invalid env payload" }));
    return;
  }

  const envKeys = Object.keys(updates).toSorted((left, right) => left.localeCompare(right));

  // Atomic consume prevents two concurrent requests from both passing the
  // validity check before either deletes the token.
  const linkToken = linkTokenStore.consume(data.token);
  if (!linkToken) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid or expired token" }));
    return;
  }

  const fileTargets: string[] = [];
  const sentryCliConfig = renderSentryCliConfig(updates);

  try {
    vaultManager.upsertEnv(linkToken.vaultId, updates);
    if (sentryCliConfig) {
      vaultManager.upsertFile(
        linkToken.vaultId,
        ".sentryclirc",
        sentryCliConfig,
        "/root/.sentryclirc",
      );
      fileTargets.push("/root/.sentryclirc");
    }
  } catch (persistError) {
    log.logWarning(
      `Failed to persist [${envKeys.join(", ")}] for ${linkToken.platform}/${linkToken.platformUserId}`,
      persistError instanceof Error ? persistError.message : String(persistError),
    );
    reportUserFacingError(persistError, {
      domain: "login",
      surface: "credential_login",
      operation: "vault_persist",
      severity: "error",
      platform: linkToken.platform,
      context: {
        conversationId: linkToken.conversationId,
        vaultId: linkToken.vaultId,
        credentialMode: data.mode ?? "manual",
        envKeyCount: envKeys.length,
        fileTargetCount: fileTargets.length,
      },
    });
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error:
          "Failed to store credential on server. Please fix the server issue and run /login again.",
      }),
    );
    return;
  }

  log.logInfo(
    `Stored [${envKeys.join(", ")}] for ${linkToken.platform}/${linkToken.platformUserId} in vault:${linkToken.vaultId}`,
  );

  const message = renderStoredEnvMessage(envKeys, fileTargets);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, message }));

  notify(
    linkToken.platform,
    linkToken.conversationId,
    `${message} Vault: \`${linkToken.vaultId}\`.`,
  ).catch((err: Error) => {
    log.logWarning("Failed to notify user after credential login", err.message);
    reportUserFacingError(err, {
      domain: "login",
      surface: "credential_login",
      operation: "notify_user",
      severity: "warning",
      platform: linkToken.platform,
      context: {
        conversationId: linkToken.conversationId,
        vaultId: linkToken.vaultId,
        credentialMode: data.mode ?? "manual",
        envKeyCount: envKeys.length,
        fileTargetCount: fileTargets.length,
      },
    });
  });
}

// ── OAuth flow ────────────────────────────────────────────────────────────────

async function handleOAuthStart(
  data: Partial<OAuthStartBody>,
  req: IncomingMessage,
  linkTokenStore: InMemoryLinkTokenStore,
  oauthStates: Map<string, PendingOAuthState>,
  res: ServerResponse,
): Promise<void> {
  if (!data.token || !data.serviceId) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing required fields: token/serviceId" }));
    return;
  }

  const linkToken = linkTokenStore.peek(data.token);
  if (!linkToken) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid or expired token" }));
    return;
  }

  const service = resolveOAuthService(data.serviceId);
  if (!service) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Unsupported OAuth service: ${data.serviceId}` }));
    return;
  }

  const clientId = readEnv(service.clientIdEnvKey);
  const clientSecret = readEnv(service.clientSecretEnvKey);
  if (!clientId || !clientSecret) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error:
          `OAuth service ${service.label} is not configured. ` +
          `Missing ${service.clientIdEnvKey}/${service.clientSecretEnvKey}.`,
      }),
    );
    return;
  }

  const state = randomBytes(16).toString("hex");
  const codeVerifier = randomBytes(32).toString("base64url");
  oauthStates.set(state, {
    linkToken: data.token,
    serviceId: service.id,
    codeVerifier,
    expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
  });

  for (const [k, v] of oauthStates) {
    if (Date.now() > v.expiresAt) oauthStates.delete(k);
  }

  const redirectUri = `${requestBaseUrl(req)}/oauth/callback`;
  const authorizeUrl = new URL(service.authorizationUrl);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("state", state);
  if (service.scopes.length > 0) {
    authorizeUrl.searchParams.set("scope", service.scopes.join(" "));
  }
  for (const [key, value] of Object.entries(service.authorizationParams ?? {})) {
    authorizeUrl.searchParams.set(key, value);
  }

  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, redirectUrl: authorizeUrl.toString() }));
}

async function handleOAuthCallback(
  url: URL,
  req: IncomingMessage,
  linkTokenStore: InMemoryLinkTokenStore,
  vaultManager: VaultManager,
  notify: NotifyFn,
  oauthStates: Map<string, PendingOAuthState>,
  res: ServerResponse,
): Promise<void> {
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const oauthError = url.searchParams.get("error");

  // Atomic pop: whatever path we take from here, this state is spent.
  // Done before any `await` to close the TOCTOU window between the state
  // lookup and the final delete.
  const pending = oauthStates.get(state);
  if (pending) oauthStates.delete(state);

  if (oauthError) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderErrorPage(`OAuth authorization failed: ${oauthError}`));
    return;
  }

  if (!pending || Date.now() > pending.expiresAt) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderErrorPage("OAuth state is invalid or expired. Please run /login again."));
    return;
  }

  if (!code) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderErrorPage("Missing OAuth authorization code."));
    return;
  }

  const service = resolveOAuthService(pending.serviceId);
  if (!service) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderErrorPage("Unsupported OAuth service."));
    return;
  }

  const clientId = readEnv(service.clientIdEnvKey);
  const clientSecret = readEnv(service.clientSecretEnvKey);
  if (!clientId || !clientSecret) {
    res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderErrorPage("OAuth service is not configured on server."));
    return;
  }

  // Atomic consume: pairs with the callback being one-shot. Two concurrent
  // callbacks for the same state would previously both pass `peek` and both
  // run `exchangeOAuthCode` across the await; only one reaches `consume`.
  const linkToken = linkTokenStore.consume(pending.linkToken);
  if (!linkToken) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderErrorPage("Login link is invalid or expired. Please run /login again."));
    return;
  }

  const redirectUri = `${requestBaseUrl(req)}/oauth/callback`;
  const tokenResp = await exchangeOAuthCode(
    service,
    code,
    clientId,
    clientSecret,
    redirectUri,
    pending.codeVerifier,
  );

  const accessToken = tokenResp.access_token?.trim();
  const refreshToken = tokenResp.refresh_token?.trim();

  if (!accessToken) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderErrorPage("OAuth token exchange did not return an access_token."));
    return;
  }

  const updates: Record<string, string> = {};
  for (const key of service.accessTokenEnvKeys ?? []) {
    updates[key] = accessToken;
  }
  if (refreshToken && service.refreshTokenEnvKey) {
    updates[service.refreshTokenEnvKey] = refreshToken;
  }

  const fileOutput = service.fileOutput;
  let mountedPath: string | undefined;
  if (fileOutput?.type === "authorized_user") {
    if (!refreshToken) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        renderErrorPage(
          "OAuth token exchange did not return a refresh_token. " +
            "Retry after revoking prior consent or ensure prompt=consent is applied.",
        ),
      );
      return;
    }

    mountedPath = fileOutput.targetPath ?? defaultVaultTargetPath(fileOutput.relativePath);
    if (fileOutput.envKey) {
      updates[fileOutput.envKey] = mountedPath;
    }
    for (const key of fileOutput.additionalEnvKeys ?? []) {
      updates[key] = mountedPath;
    }
  }

  const storedTargets: string[] = [];
  try {
    if (Object.keys(updates).length > 0) {
      vaultManager.upsertEnv(linkToken.vaultId, updates);
      storedTargets.push(...Object.keys(updates).toSorted());
    }
    if (fileOutput?.type === "authorized_user" && refreshToken) {
      vaultManager.upsertFile(
        linkToken.vaultId,
        fileOutput.relativePath,
        renderAuthorizedUserCredential(clientId, clientSecret, refreshToken),
        fileOutput.targetPath,
      );
      if (mountedPath) storedTargets.push(mountedPath);
    }
  } catch (persistError) {
    log.logWarning(
      `Failed to persist OAuth credentials for ${linkToken.platform}/${linkToken.platformUserId}`,
      persistError instanceof Error ? persistError.message : String(persistError),
    );
    reportUserFacingError(persistError, {
      domain: "login",
      surface: "oauth",
      operation: "vault_persist",
      severity: "error",
      platform: linkToken.platform,
      context: {
        conversationId: linkToken.conversationId,
        vaultId: linkToken.vaultId,
        serviceId: service.id,
        credentialMode: "oauth",
        storedTargetCount: storedTargets.length,
      },
    });
    res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      renderErrorPage(
        "OAuth tokens were received but could not be stored on the server. Fix the server issue and run /login again.",
      ),
    );
    return;
  }

  log.logInfo(
    `Stored [${storedTargets.join(", ")}] for ${linkToken.platform}/${linkToken.platformUserId} in vault:${linkToken.vaultId}`,
  );

  notify(
    linkToken.platform,
    linkToken.conversationId,
    `${service.label} OAuth stored (${storedTargets.join(", ")}) in vault \`${linkToken.vaultId}\`.`,
  ).catch((err: Error) => {
    log.logWarning("Failed to notify user after OAuth login", err.message);
    reportUserFacingError(err, {
      domain: "login",
      surface: "oauth",
      operation: "notify_user",
      severity: "warning",
      platform: linkToken.platform,
      context: {
        conversationId: linkToken.conversationId,
        vaultId: linkToken.vaultId,
        serviceId: service.id,
        credentialMode: "oauth",
        storedTargetCount: storedTargets.length,
      },
    });
  });

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(renderSuccessPage(`${service.label} OAuth connected successfully.`));
}

async function exchangeOAuthCode(
  service: OAuthService,
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<Record<string, string>> {
  const params = new URLSearchParams();
  params.set("grant_type", "authorization_code");
  params.set("code", code);
  params.set("client_id", clientId);
  params.set("client_secret", clientSecret);
  params.set("redirect_uri", redirectUri);
  params.set("code_verifier", codeVerifier);

  const response = await fetch(service.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: params.toString(),
  });

  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  let parsed: Record<string, string> = {};

  if (contentType.includes("application/json")) {
    parsed = JSON.parse(text) as Record<string, string>;
  } else {
    const form = new URLSearchParams(text);
    parsed = Object.fromEntries(form.entries());
  }

  if (!response.ok) {
    const message = parsed.error_description ?? parsed.error ?? `${response.status}`;
    throw new Error(`OAuth token exchange failed for ${service.id}: ${message}`);
  }

  return parsed;
}

function renderAuthorizedUserCredential(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): string {
  return (
    JSON.stringify(
      {
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        type: "authorized_user",
      },
      null,
      2,
    ) + "\n"
  );
}
