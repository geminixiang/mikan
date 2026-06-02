import { escapeHtml } from "./html.js";
import { PRODUCT_NAME } from "./platform-messages.js";

// ── Shared portal shell ────────────────────────────────────────────────────────
//
// Three portals (admin / session / vault aka login) share the same chrome:
// - Fixed left rail with three round icon buttons (admin, session, vault)
// - Compact topbar (product wordmark + identity + optional conversation switcher)
// - Main content area
//
// Each portal renders its own page-head + body inside <main class="shell">.
// Sidebar buttons whose target token isn't available are rendered as anchors
// only when href is provided; otherwise they are buttons in a disabled state.

type PortalView = "admin" | "session" | "vault";

export interface PortalShellOptions {
  activeView: PortalView;
  pageTitle: string;
  identity?: {
    primary: string;
    secondary?: string;
  };
  conversationSwitcher?: {
    currentId: string;
    options?: Array<{ id: string; label: string; running?: boolean }>;
  };
  navLinks?: Partial<Record<PortalView, string>>;
  body: string;
  /** Additional CSS appended after the shared stylesheet. */
  extraStyles?: string;
  /** Inline script run after body. */
  inlineScript?: string;
  /** Extra <head> markup (e.g., third-party fonts already loaded by shared CSS, so usually empty). */
  extraHead?: string;
  /** Body-level data-* attributes (e.g., data-session-running). */
  bodyAttributes?: Record<string, string>;
}

const NAV_ICONS: Record<PortalView, { label: string; svg: string }> = {
  admin: {
    label: "Admin",
    svg: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </svg>`,
  },
  session: {
    label: "Session",
    svg: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
    </svg>`,
  },
  vault: {
    label: "Vault",
    svg: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
      <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
    </svg>`,
  },
};

function renderNav(activeView: PortalView, navLinks: Partial<Record<PortalView, string>>): string {
  const views: PortalView[] = ["admin", "session", "vault"];
  const buttons = views.map((view) => {
    const meta = NAV_ICONS[view];
    const isActive = view === activeView;
    const href = navLinks[view];
    const baseClass = `view-nav-btn${isActive ? " active" : ""}${!href && !isActive ? " disabled" : ""}`;
    const attrs = `data-view="${view}" aria-label="${escapeHtml(meta.label)}" data-tooltip="${escapeHtml(meta.label)}"`;
    if (href && !isActive) {
      return `<a class="${baseClass}" href="${escapeHtml(href)}" ${attrs}>${meta.svg}</a>`;
    }
    if (isActive) {
      return `<span class="${baseClass}" aria-current="page" ${attrs}>${meta.svg}</span>`;
    }
    return `<span class="${baseClass}" aria-disabled="true" ${attrs} data-tooltip="${escapeHtml(meta.label)} (no token)">${meta.svg}</span>`;
  });
  return `<nav class="floating-view-nav" aria-label="Primary views">${buttons.join("")}</nav>`;
}

function renderTopbar(options: PortalShellOptions): string {
  const identity = options.identity
    ? `<span class="topbar-user">${escapeHtml(options.identity.primary)}${options.identity.secondary ? ` · ${escapeHtml(options.identity.secondary)}` : ""}</span>`
    : "";

  let switcher = "";
  if (options.conversationSwitcher) {
    const { currentId, options: convOptions } = options.conversationSwitcher;
    if (convOptions && convOptions.length > 0) {
      const opts = convOptions
        .map((c) => {
          const label = `${c.label}${c.running ? " (running)" : ""}`;
          const selected = c.id === currentId ? " selected" : "";
          return `<option value="${escapeHtml(c.id)}"${selected}>${escapeHtml(label)}</option>`;
        })
        .join("");
      switcher = `<select id="conv-switcher" class="conv-inline-select" aria-label="Switch conversation">${opts}</select>`;
    } else {
      switcher = `<select id="conv-switcher" class="conv-inline-select" aria-label="Switch conversation"><option>${escapeHtml(currentId)}</option></select>`;
    }
  }

  return `<header class="topbar">
    <div class="topbar-brand">
      <span class="topbar-wordmark">${PRODUCT_NAME}</span>
      <span class="topbar-sep">·</span>
      <span class="topbar-title">${escapeHtml(options.pageTitle)}</span>
    </div>
    <div class="topbar-meta">
      ${identity}
      ${switcher}
    </div>
  </header>`;
}

export function renderPortalShell(options: PortalShellOptions): string {
  const bodyAttrs = Object.entries(options.bodyAttributes ?? {})
    .map(([key, value]) => `${escapeHtml(key)}="${escapeHtml(value)}"`)
    .join(" ");
  const titleText = `${options.pageTitle} — ${PRODUCT_NAME}`;
  const nav = renderNav(options.activeView, options.navLinks ?? {});
  const topbar = renderTopbar(options);
  const extraStyles = options.extraStyles ? `<style>${options.extraStyles}</style>` : "";
  const inlineScript = options.inlineScript ? `<script>${options.inlineScript}</script>` : "";
  const extraHead = options.extraHead ?? "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(titleText)}</title>
  <style>${portalShellStyles}</style>
  ${extraStyles}
  ${extraHead}
</head>
<body${bodyAttrs ? ` ${bodyAttrs}` : ""}>
  ${nav}
  <main class="shell">
    ${topbar}
    ${options.body}
  </main>
  ${inlineScript}
</body>
</html>`;
}

// ── Shared stylesheet ──────────────────────────────────────────────────────────

const portalShellStyles = `
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
    --err-bg: #fef2f2;
    --err-text: #b91c1c;
    --err-border: rgba(185, 28, 28, 0.14);
  }

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    min-height: 100vh;
    padding: 28px 24px 60px;
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
    max-width: 960px;
    margin-left: 72px;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }

  /* ── Topbar ─────────────────────────────────────────────────────────── */

  .topbar {
    display: flex; align-items: center; justify-content: space-between;
    gap: 16px; padding: 10px 18px;
    border: 1px solid var(--border); border-radius: 14px;
    background: rgba(255,255,255,0.7); backdrop-filter: blur(8px);
  }
  .topbar-brand { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
  .topbar-wordmark {
    font-family: 'Lora', Georgia, serif; font-size: 1.05rem; font-weight: 600;
    color: var(--text); letter-spacing: -0.01em;
  }
  .topbar-sep { color: var(--subtle); font-size: 0.9rem; }
  .topbar-title { font-size: 0.86rem; color: var(--muted); font-weight: 500; }
  .topbar-meta {
    display: flex; align-items: center; gap: 12px; min-width: 0; flex-wrap: wrap;
    justify-content: flex-end;
  }
  .topbar-user {
    font-size: 0.8rem; color: var(--muted);
    padding: 4px 10px; border-radius: 999px; background: rgba(0,0,0,0.04);
    white-space: nowrap;
  }
  .conv-inline-select {
    max-width: min(360px, 100%);
    padding: 6px 10px; border: 1px solid var(--border); border-radius: 10px;
    background: #fff; font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.76rem;
    color: var(--text); cursor: pointer;
    transition: border-color 120ms;
  }
  .conv-inline-select:hover { border-color: rgba(0,0,0,0.18); }
  .conv-inline-select:focus-visible { outline: 2px solid var(--text); outline-offset: 1px; }

  /* ── Floating icon nav ──────────────────────────────────────────────── */

  .floating-view-nav {
    position: fixed;
    left: 20px;
    top: 50%;
    transform: translateY(-50%);
    z-index: 20;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 6px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: rgba(255,255,255,0.88);
    box-shadow: 0 10px 32px rgba(0,0,0,0.10), 0 2px 6px rgba(0,0,0,0.04);
    backdrop-filter: blur(14px);
  }
  .view-nav-btn {
    position: relative;
    display: flex; align-items: center; justify-content: center;
    width: 40px; height: 40px;
    border: none; border-radius: 999px; background: transparent;
    color: var(--muted); cursor: pointer;
    text-decoration: none;
    transition: background 160ms, color 160ms, transform 160ms;
  }
  .view-nav-btn:hover { background: rgba(0,0,0,0.05); color: var(--text); }
  .view-nav-btn:active { transform: scale(0.94); }
  .view-nav-btn.active {
    background: var(--text); color: #fff;
    box-shadow: 0 2px 8px rgba(0,0,0,0.18);
    cursor: default;
  }
  .view-nav-btn.disabled {
    opacity: 0.4; cursor: not-allowed;
  }
  .view-nav-btn.disabled:hover { background: transparent; color: var(--muted); }
  .view-nav-btn svg { display: block; }

  /* Tooltip */
  .view-nav-btn::after {
    content: attr(data-tooltip);
    position: absolute;
    left: calc(100% + 12px);
    top: 50%;
    transform: translateY(-50%) translateX(-4px);
    padding: 5px 10px;
    border-radius: 8px;
    background: var(--text);
    color: #fff;
    font: 500 0.76rem/1 'DM Sans', sans-serif;
    white-space: nowrap;
    opacity: 0;
    pointer-events: none;
    transition: opacity 140ms, transform 140ms;
    box-shadow: 0 4px 12px rgba(0,0,0,0.16);
  }
  .view-nav-btn::before {
    content: '';
    position: absolute;
    left: calc(100% + 6px);
    top: 50%;
    transform: translateY(-50%);
    border: 5px solid transparent;
    border-right-color: var(--text);
    opacity: 0;
    pointer-events: none;
    transition: opacity 140ms;
  }
  .view-nav-btn:hover::after,
  .view-nav-btn:focus-visible::after {
    opacity: 1;
    transform: translateY(-50%) translateX(0);
  }
  .view-nav-btn:hover::before,
  .view-nav-btn:focus-visible::before {
    opacity: 1;
  }

  /* ── Generic page-head ───────────────────────────────────────────────── */

  .page-head {
    display: flex; justify-content: space-between; align-items: flex-start; gap: 14px;
    padding: 2px 4px;
  }
  .page-title {
    font-family: 'Lora', Georgia, serif;
    font-size: clamp(1.35rem, 2.4vw, 1.6rem);
    font-weight: 600; line-height: 1.2; letter-spacing: -0.01em;
  }
  .page-desc { color: var(--muted); font-size: 0.9rem; margin-top: 4px; }
  .eyebrow {
    color: var(--subtle); font-size: 0.72rem; font-weight: 600;
    letter-spacing: 0.12em; text-transform: uppercase; margin-bottom: 6px;
  }

  /* ── Cards ──────────────────────────────────────────────────────────── */

  .card {
    padding: 24px 28px;
    border: 1px solid var(--border);
    border-radius: 20px;
    background: var(--surface);
    box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.06);
  }
  .card-title {
    font-family: 'Lora', Georgia, serif;
    font-size: clamp(1.1rem, 2vw, 1.3rem);
    font-weight: 600; line-height: 1.25; letter-spacing: -0.01em;
    margin-bottom: 10px;
  }
  .card-subtitle { font-size: 1rem; font-weight: 650; margin-bottom: 10px; line-height: 1.3; }

  code {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 0.82em; padding: 0.14em 0.36em;
    border-radius: 6px; background: rgba(0,0,0,0.05); color: var(--text);
  }

  button:focus-visible { outline: 2px solid var(--text); outline-offset: 2px; }

  .primary-action-btn {
    padding: 9px 16px;
    border: none; border-radius: 10px;
    background: var(--text); color: #fff;
    font: 500 0.86rem/1.2 'DM Sans', sans-serif;
    cursor: pointer;
    transition: opacity 120ms;
  }
  .primary-action-btn:hover:not(:disabled) { opacity: 0.85; }
  .primary-action-btn:disabled { opacity: 0.5; cursor: wait; }

  .loading-msg { color: var(--muted); font-size: 0.9rem; padding: 8px 0; }
  .err-msg {
    padding: 12px 16px; border-radius: 10px;
    background: var(--err-bg); color: var(--err-text);
    border: 1px solid var(--err-border); font-size: 0.88rem;
  }
  .empty-state {
    padding: 18px 8px; text-align: center; color: var(--muted);
    font-size: 0.88rem;
  }
  .inline-result {
    padding: 8px 12px; border-radius: 8px; font-size: 0.82rem; margin-top: 4px;
  }
  .inline-result.ok { background: var(--ok-bg); color: var(--ok-text); border: 1px solid var(--ok-border); }
  .inline-result.err { background: var(--err-bg); color: var(--err-text); border: 1px solid var(--err-border); }

  @media (max-width: 900px) {
    .shell { margin-left: 0; }
    .floating-view-nav {
      left: 50%; right: auto; top: auto; bottom: 18px;
      transform: translateX(-50%); flex-direction: row;
    }
    .view-nav-btn::after {
      left: 50%; top: auto; bottom: calc(100% + 10px);
      transform: translateX(-50%) translateY(4px);
    }
    .view-nav-btn::before {
      left: 50%; top: auto; bottom: calc(100% + 4px);
      transform: translateX(-50%);
      border-right-color: transparent;
      border-top-color: var(--text);
    }
    .view-nav-btn:hover::after,
    .view-nav-btn:focus-visible::after { transform: translateX(-50%) translateY(0); }
  }

  @media (max-width: 640px) {
    body { padding: 16px 12px 96px; }
    .topbar { padding: 10px 14px; border-radius: 12px; }
    .topbar-meta { gap: 8px; }
    .page-head { padding-inline: 2px; }
    .card { padding: 18px; border-radius: 16px; }
  }
`;
