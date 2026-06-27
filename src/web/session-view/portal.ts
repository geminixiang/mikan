import type { IncomingMessage, ServerResponse } from "http";
import { basename } from "path";
import MarkdownIt from "markdown-it";
import type {
  ConversationContext,
  ConversationEvent,
  ConversationResponder,
} from "../../adapter.js";
import { readRawBody } from "../../utils/http-body.js";
import { escapeHtml } from "../../utils/html.js";
import * as log from "../../log.js";
import { renderPortalShell } from "../../portal-shell.js";
import { reportUserFacingError } from "../../observability/sentry.js";
import { inferConversationKind } from "../../sessions/policy.js";
import {
  loadSessionViewModel,
  resolveRequestedSessionFile,
  type SessionViewItem,
  type SessionViewRelation,
} from "./service.js";
import type { InMemorySessionViewTokenStore } from "./store.js";

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
});

const defaultLinkOpen = markdown.renderer.rules.link_open;
type LinkOpenRule = NonNullable<typeof defaultLinkOpen>;
markdown.renderer.rules.link_open = (...args: Parameters<LinkOpenRule>) => {
  const [tokens, idx, options, env, self] = args;
  const token = tokens[idx];
  token.attrSet("target", "_blank");
  token.attrSet("rel", "noreferrer noopener");
  return defaultLinkOpen
    ? defaultLinkOpen(tokens, idx, options, env, self)
    : self.renderToken(tokens, idx, options);
};

type SessionStreamEvent =
  | { type: "status"; running: boolean }
  | { type: "user"; html: string }
  | { type: "assistant"; html: string }
  | { type: "assistant_remove" }
  | { type: "tool"; html: string }
  | { type: "system"; html: string }
  | {
      type: "refresh";
      timelineHtml: string;
      updatedAt: string;
      entryCount: number;
      running: boolean;
    }
  | { type: "error"; message: string };

class SessionViewStreamHub {
  private listeners = new Map<string, Set<(event: SessionStreamEvent) => void>>();

  subscribe(key: string, listener: (event: SessionStreamEvent) => void): () => void {
    const set = this.listeners.get(key) ?? new Set<(event: SessionStreamEvent) => void>();
    set.add(listener);
    this.listeners.set(key, set);
    return () => {
      const current = this.listeners.get(key);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(key);
    };
  }

  publish(key: string, event: SessionStreamEvent): void {
    const set = this.listeners.get(key);
    if (!set) return;
    for (const listener of set) listener(event);
  }
}

const sessionViewStreamHub = new SessionViewStreamHub();

export type { SessionViewInteractiveOptions } from "./types.js";
import type { SessionViewInteractiveOptions } from "./types.js";

export async function handleSessionViewRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  sessionViewTokenStore?: InMemorySessionViewTokenStore,
  interactive?: SessionViewInteractiveOptions,
): Promise<boolean> {
  if (req.method === "POST" && url.pathname === "/session/message") {
    await handleSessionMessageRequest(req, res, sessionViewTokenStore, interactive);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/session/stream") {
    await handleSessionStreamRequest(req, res, url, sessionViewTokenStore, interactive);
    return true;
  }

  if (req.method !== "GET" || url.pathname !== "/session") {
    return false;
  }

  const token = url.searchParams.get("token")?.trim();
  if (!token || !sessionViewTokenStore) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      renderStatusPage("Session unavailable", "This session link is invalid or has expired."),
    );
    return true;
  }

  const entry = sessionViewTokenStore.peek(token);
  if (!entry) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      renderStatusPage("Session unavailable", "This session link is invalid or has expired."),
    );
    return true;
  }

  const requestedSession = url.searchParams.get("session");
  let targetSessionFile: string | null;
  try {
    targetSessionFile = resolveRequestedSessionFile(entry.sessionFile, requestedSession);
  } catch (error) {
    log.logWarning(
      `[${entry.conversationId}] Corrupted session file referenced for ${entry.sessionFile}`,
      error instanceof Error ? error.message : String(error),
    );
    reportUserFacingError(error, {
      domain: "session_view",
      surface: "session_view",
      operation: "resolve_requested_session",
      severity: "error",
      platform: entry.platform,
      context: {
        conversationId: entry.conversationId,
        sessionKey: entry.sessionKey,
        sessionFile: basename(entry.sessionFile),
        requestedSession,
      },
    });
    res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      renderStatusPage("Session unavailable", "The selected session file appears to be corrupted."),
    );
    return true;
  }
  if (!targetSessionFile) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderStatusPage("Session unavailable", "The selected session link is invalid."));
    return true;
  }

  try {
    const model = loadSessionViewModel(targetSessionFile);
    const displayedSessionKey = resolveDisplayedSessionKey(entry, targetSessionFile);
    const isRunning = interactive?.handler.isRunning(displayedSessionKey) ?? false;
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(
      renderSessionPage(
        model,
        entry.token,
        entry.expiresAt,
        isRunning,
        displayedSessionKey,
        entry.conversationId,
      ),
    );
  } catch (error) {
    log.logWarning(
      `[${entry.conversationId}] Failed to render session ${entry.sessionFile}`,
      error instanceof Error ? error.message : String(error),
    );
    reportUserFacingError(error, {
      domain: "session_view",
      surface: "session_view",
      operation: "render_session",
      severity: "error",
      platform: entry.platform,
      context: {
        conversationId: entry.conversationId,
        sessionKey: entry.sessionKey,
        sessionFile: basename(targetSessionFile),
      },
    });
    res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderStatusPage("Session unavailable", "The session could not be loaded right now."));
  }

  return true;
}

function resolveDisplayedSessionKey(
  entry: { platform: string; conversationId: string; sessionKey: string },
  sessionFile: string,
): string {
  if (entry.platform === "slack") {
    const fileName = basename(sessionFile, ".jsonl");
    if (/^\d+\.\d+$/.test(fileName)) {
      return `${entry.conversationId}:${fileName}`;
    }
    return entry.conversationId;
  }
  return entry.sessionKey;
}

function sessionStreamKey(entry: {
  platform: string;
  conversationId: string;
  sessionKey: string;
}): string {
  return `${entry.platform}:${entry.conversationId}:${entry.sessionKey}`;
}

function renderTimelineItems(items: SessionViewItem[], token: string): string {
  return items.length > 0
    ? items.map((item) => renderItem(item, token)).join("\n")
    : `<div class="system-event"><span class="event-dot"></span><span class="event-text">No messages yet — send one to the bot, then refresh.</span></div>`;
}

function renderSessionPage(
  model: {
    title: string;
    sessionId: string;
    fileName: string;
    createdAt: string;
    updatedAt: string;
    entryCount: number;
    items: SessionViewItem[];
    parent?: SessionViewRelation;
    threads: SessionViewRelation[];
  },
  token: string,
  expiresAt: number,
  isRunning: boolean,
  displayedSessionKey: string,
  conversationId: string,
): string {
  const items = renderTimelineItems(model.items, token);

  const relatedSections = model.parent
    ? `<section class="related-card stack">
        <p class="eyebrow">Parent session</p>
        ${renderRelationCard(model.parent, token)}
      </section>`
    : "";

  const body = `<header class="page-head">
      <div>
        <p class="eyebrow">Session</p>
        <h2 class="page-title">${esc(model.title)}</h2>
        <p class="page-desc">
          <span>Created ${esc(formatDate(model.createdAt))}</span> ·
          <span>Updated <strong data-session-updated>${esc(formatDate(model.updatedAt))}</strong></span> ·
          <span><strong data-session-entries>${esc(String(model.entryCount))}</strong> entries</span>
        </p>
      </div>
      <div class="session-side">
        <span class="session-badge session-badge-status${isRunning ? " is-running" : ""}"><span class="session-badge-dot"></span><strong data-session-status>${esc(isRunning ? "Running" : "Idle")}</strong></span>
        <span class="session-badge">${esc(displayedSessionKey === conversationId ? "Channel" : "Thread")}</span>
      </div>
    </header>

    <div class="session-detail-row">
      <span class="session-detail"><span class="session-detail-label">Session</span><code>${esc(model.sessionId.slice(0, 8))}</code></span>
      <span class="session-detail"><span class="session-detail-label">File</span><code>${esc(model.fileName)}</code></span>
      <span class="session-detail"><span class="session-detail-label">Expires</span><span>${esc(formatDate(new Date(expiresAt).toISOString()))}</span></span>
    </div>

    ${relatedSections}

    <div class="timeline-shell">
      <div class="timeline-list" data-timeline-list>
        ${items}
      </div>
    </div>

    <button class="jump-latest-btn" type="button" hidden data-jump-latest aria-label="Jump to latest" title="Jump to latest">↓</button>

    <section class="composer-card">
      <form class="composer-form" data-session-composer>
        <input type="hidden" name="token" value="${esc(token)}">
        <input type="hidden" name="session" value="${esc(model.fileName)}">
        <input type="hidden" name="sessionKey" value="${esc(displayedSessionKey)}">
        <textarea name="text" rows="1" placeholder="Ask mikan in this session… (replies stay in Session View)" required></textarea>
        <div class="composer-actions">
          <span class="composer-status" data-composer-status></span>
          <button class="composer-send-btn" type="submit" aria-label="Send" title="Send">↑</button>
        </div>
      </form>
    </section>`;

  return renderHtmlDocument(`${model.title} · Session Viewer`, body, isRunning);
}

function renderRelationCard(relation: SessionViewRelation, token: string): string {
  const href = `/session?token=${encodeURIComponent(token)}&session=${encodeURIComponent(relation.fileName)}`;
  const summary = relation.summary ? `<p class="related-summary">${esc(relation.summary)}</p>` : "";
  return `<a class="related-link" href="${href}">
    <span class="related-copy">
      <strong class="related-title">${esc(relation.title)}</strong>
      ${summary}
      <span class="related-meta">${esc(formatDate(relation.updatedAt))} · ${esc(String(relation.entryCount))} entries · ${esc(relation.fileName)}</span>
    </span>
    <span class="related-arrow" aria-hidden="true">→</span>
  </a>`;
}

function renderThreadLinks(relations: SessionViewRelation[] | undefined, token: string): string {
  if (!relations || relations.length === 0) return "";
  return `<div class="thread-links">${relations
    .map((relation) => {
      const href = `/session?token=${encodeURIComponent(token)}&session=${encodeURIComponent(relation.fileName)}`;
      return `<a class="thread-link" href="${href}" title="Open ${esc(relation.title)}">
        <span class="thread-dot" aria-hidden="true"></span>
        <span class="thread-text">Thread</span>
      </a>`;
    })
    .join("")}</div>`;
}

export function parseUserBody(raw: string): {
  timestamp: string | null;
  username: string | null;
  threadTs: string | null;
  header: string | null;
  content: string;
} {
  // [timestamp] [username] [in-thread:ts]: content
  let m = raw.match(
    /^\[([0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}[+-][0-9]{2}:[0-9]{2})\]\s*\[([^\]]+)\](?:\s*\[in-thread:([^\]]+)\])?:\s*([\s\S]*)$/,
  );
  if (m) {
    const header = [`[${m[1]}]`, `[${m[2]}]`, m[3] ? `[in-thread:${m[3]}]` : ""]
      .filter(Boolean)
      .join(" ");
    return {
      timestamp: m[1],
      username: m[2],
      threadTs: m[3] ?? null,
      header,
      content: m[4],
    };
  }
  // [username] [in-thread:ts]: content
  m = raw.match(/^\[([^\]]+)\](?:\s*\[in-thread:([^\]]+)\])?:\s*([\s\S]*)$/);
  if (m) {
    const header = [`[${m[1]}]`, m[2] ? `[in-thread:${m[2]}]` : ""].filter(Boolean).join(" ");
    return {
      timestamp: null,
      username: m[1],
      threadTs: m[2] ?? null,
      header,
      content: m[3],
    };
  }
  return { timestamp: null, username: null, threadTs: null, header: null, content: raw };
}

type ParsedUserBody = ReturnType<typeof parseUserBody>;

function renderCopyButton(label = "Copy message"): string {
  return `<div class="msg-actions"><button class="copy-action-btn" type="button" data-copy-button data-copy-label="${esc(label)}" aria-label="${esc(label)}" title="${esc(label)}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.8"></rect><path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path></svg></button></div>`;
}

function renderItem(item: SessionViewItem, token?: string): string {
  if (item.kind === "system") {
    const parts = [item.title, item.body].filter((x): x is string => Boolean(x)).map(esc);
    const time = item.meta
      ? ` · <time class="event-time">${esc(formatDate(item.meta))}</time>`
      : "";
    return `<div class="system-event"><span class="event-dot"></span><span class="event-text">${parts.join(" — ")}</span>${time}</div>`;
  }

  if (item.kind === "tool") {
    const toneClass = item.tone === "err" ? " tone-err" : item.tone === "ok" ? " tone-ok" : "";
    const body = item.body ? `<pre class="tool-output${toneClass}">${esc(item.body)}</pre>` : "";
    const time = item.meta ? `<time class="tool-time">${esc(formatDate(item.meta))}</time>` : "";
    return `<div class="tool-block">
  <div class="tool-header">
    <span class="tool-icon"><svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M1.5 2L5 5.5 1.5 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 9h2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></span>
    <span class="tool-name">${esc(item.title)}</span>
    ${time}
  </div>
  ${body}
</div>`;
  }

  const time = item.meta ? `<time class="msg-time">${esc(formatDate(item.meta))}</time>` : "";

  if (item.kind === "user") {
    const parsed: ParsedUserBody = item.body
      ? parseUserBody(item.body)
      : { timestamp: null, username: null, threadTs: null, header: null, content: "" };
    const { username, threadTs, header, content } = parsed;
    const initial = username ? esc(username.slice(0, 2).toUpperCase()) : "U";
    const rawHeader = header ? `<div class="msg-raw-header">${esc(header)}</div>` : "";
    const body = content ? renderMarkdownBlock(content, "user") : "";
    const threadBadge = threadTs
      ? `<div class="thread-badge" title="Thread ${esc(threadTs)}">Thread · <code>${esc(threadTs)}</code></div>`
      : "";
    const threads = renderThreadLinks(item.threads, token ?? "");
    return `<div class="msg-row msg-user copy-host">
  <div class="msg-main user-main">
    <div class="user-bubble">
      ${rawHeader}
      ${threadBadge}
      ${body}
      ${threads}
      ${time}
    </div>
    ${renderCopyButton()}
  </div>
  <div class="msg-avatar user-avatar" title="${username ? esc(username) : "User"}">${initial}</div>
</div>`;
  }

  // assistant
  const body = item.body ? renderMarkdownBlock(item.body, "assistant") : "";
  const threads = renderThreadLinks(item.threads, token ?? "");
  return `<div class="msg-row msg-assistant copy-host">
  <div class="msg-avatar asst-avatar" aria-hidden="true">A</div>
  <div class="msg-main asst-main">
    <div class="asst-card">
      ${body}
      ${threads}
      ${time}
    </div>
    ${renderCopyButton()}
  </div>
</div>`;
}

function renderMarkdownBlock(text: string, variant: "user" | "assistant"): string {
  return `<div class="msg-body markdown-body markdown-${variant}">${markdown.render(text)}</div>`;
}

function renderLiveUserMessage(text: string, userName: string): string {
  const initial = esc(userName.slice(0, 2).toUpperCase());
  return `<div class="msg-row msg-user copy-host" data-live-item>
  <div class="msg-main user-main">
    <div class="user-bubble">
      ${renderMarkdownBlock(text, "user")}
    </div>
    ${renderCopyButton()}
  </div>
  <div class="msg-avatar user-avatar" title="${esc(userName)}">${initial}</div>
</div>`;
}

function renderLiveAssistantMessage(text: string): string {
  return `<div class="msg-row msg-assistant copy-host" data-live-assistant>
  <div class="msg-avatar asst-avatar" aria-hidden="true">A</div>
  <div class="msg-main asst-main">
    <div class="asst-card">
      ${renderMarkdownBlock(text, "assistant")}
    </div>
    ${renderCopyButton()}
  </div>
</div>`;
}

function renderLiveToolResult(result: {
  toolName: string;
  result: string;
  isError: boolean;
}): string {
  const toneClass = result.isError ? " tone-err" : " tone-ok";
  return `<div class="tool-block" data-live-item>
  <div class="tool-header">
    <span class="tool-icon"><svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M1.5 2L5 5.5 1.5 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 9h2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></span>
    <span class="tool-name">${esc(result.toolName)}</span>
  </div>
  <pre class="tool-output${toneClass}">${esc(result.result)}</pre>
</div>`;
}

function renderLiveSystemEvent(text: string, tone: "default" | "err" = "default"): string {
  const cls = tone === "err" ? " system-event-err" : "";
  return `<div class="system-event${cls}" data-live-item><span class="event-dot"></span><span class="event-text">${esc(text)}</span></div>`;
}

async function handleSessionStreamRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  sessionViewTokenStore?: InMemorySessionViewTokenStore,
  interactive?: SessionViewInteractiveOptions,
): Promise<void> {
  const token = url.searchParams.get("token")?.trim() ?? "";
  if (!token || !sessionViewTokenStore || !interactive) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Session stream unavailable");
    return;
  }

  const entry = sessionViewTokenStore.peek(token);
  if (!entry) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Invalid session token");
    return;
  }

  const requestedSession = url.searchParams.get("session");
  let targetSessionFile: string | null;
  try {
    targetSessionFile = resolveRequestedSessionFile(entry.sessionFile, requestedSession);
  } catch (error) {
    reportUserFacingError(error, {
      domain: "session_view",
      surface: "session_view",
      operation: "session_stream",
      severity: "error",
      platform: entry.platform,
      context: {
        conversationId: entry.conversationId,
        sessionKey: entry.sessionKey,
        sessionFile: basename(entry.sessionFile),
        requestedSession,
      },
    });
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Session stream unavailable");
    return;
  }
  if (!targetSessionFile) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Invalid session file");
    return;
  }
  const activeSessionKey = resolveDisplayedSessionKey(entry, targetSessionFile);
  const streamKey = sessionStreamKey({ ...entry, sessionKey: activeSessionKey });
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
  res.write(
    `data: ${JSON.stringify({ type: "status", running: interactive.handler.isRunning(activeSessionKey) })}\n\n`,
  );

  const unsubscribe = sessionViewStreamHub.subscribe(streamKey, (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });
  const heartbeat = setInterval(() => {
    res.write(": keep-alive\n\n");
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

async function handleSessionMessageRequest(
  req: IncomingMessage,
  res: ServerResponse,
  sessionViewTokenStore?: InMemorySessionViewTokenStore,
  interactive?: SessionViewInteractiveOptions,
): Promise<void> {
  if (!sessionViewTokenStore || !interactive) {
    json(res, 503, { ok: false, error: "Session chat is not configured." });
    return;
  }

  const rawBody = await readRawBody(req, res, 1024 * 1024);
  if (rawBody === null) return;

  let body: { token?: string; text?: string; session?: string; sessionKey?: string };
  try {
    body = JSON.parse(rawBody) as {
      token?: string;
      text?: string;
      session?: string;
      sessionKey?: string;
    };
  } catch {
    json(res, 400, { ok: false, error: "Invalid request body." });
    return;
  }

  const token = body.token?.trim() ?? "";
  const text = body.text?.trim() ?? "";
  const requestedSession = body.session?.trim() || null;
  const requestedSessionKey = body.sessionKey?.trim() || "";
  if (!token || !text) {
    json(res, 400, { ok: false, error: "Missing token or text." });
    return;
  }

  const entry = sessionViewTokenStore.peek(token);
  if (!entry) {
    json(res, 400, { ok: false, error: "This session link is invalid or has expired." });
    return;
  }

  let targetSessionFile: string | null;
  try {
    targetSessionFile = resolveRequestedSessionFile(entry.sessionFile, requestedSession);
  } catch (error) {
    reportUserFacingError(error, {
      domain: "session_view",
      surface: "session_view",
      operation: "session_message",
      severity: "error",
      platform: entry.platform,
      context: {
        conversationId: entry.conversationId,
        sessionKey: entry.sessionKey,
        sessionFile: basename(entry.sessionFile),
        requestedSession,
      },
    });
    json(res, 500, { ok: false, error: "Session file could not be loaded." });
    return;
  }
  if (!targetSessionFile) {
    json(res, 400, { ok: false, error: "Invalid session file." });
    return;
  }
  const activeSessionKey = resolveDisplayedSessionKey(entry, targetSessionFile);
  if (requestedSessionKey && requestedSessionKey !== activeSessionKey) {
    json(res, 400, { ok: false, error: "Session target mismatch." });
    return;
  }

  const bot = interactive.botsByPlatform[entry.platform];
  if (!bot) {
    json(res, 503, { ok: false, error: `No bot configured for ${entry.platform}.` });
    return;
  }

  const streamKey = sessionStreamKey({ ...entry, sessionKey: activeSessionKey });
  const conversationKind = inferConversationKind(entry.platform, entry.conversationId);
  const ts = (Date.now() / 1000).toFixed(6);
  const platformInfo = bot.getMessagingInfo();
  const platformUserName =
    entry.platformUserName ||
    platformInfo.users.find((user) => user.id === entry.platformUserId)?.userName ||
    platformInfo.users.find((user) => user.id === entry.platformUserId)?.displayName ||
    "unknown";
  const responder = createSessionViewResponseContext((event) => {
    sessionViewStreamHub.publish(streamKey, event);
  });
  const event: ConversationEvent = {
    type: "session_view",
    conversationId: entry.conversationId,
    conversationKind,
    ts,
    user: entry.platformUserId,
    text,
    attachments: [],
    sessionKey: activeSessionKey,
    ...(activeSessionKey.includes(":")
      ? { thread_ts: activeSessionKey.split(":").slice(1).join(":") }
      : {}),
  };
  const context: ConversationContext = {
    message: {
      id: ts,
      sessionKey: activeSessionKey,
      conversationKind,
      userId: entry.platformUserId,
      userName: platformUserName,
      text,
      attachments: [],
      threadTs: event.thread_ts,
    },
    responder,
    platform: { ...platformInfo, diagnostics: { showUsageSummary: false } },
  };

  sessionViewStreamHub.publish(streamKey, { type: "status", running: true });
  sessionViewStreamHub.publish(streamKey, {
    type: "user",
    html: renderLiveUserMessage(text, platformUserName),
  });

  void interactive.handler
    .handleEvent(event, bot, context)
    .then(() => {
      if (!targetSessionFile) {
        sessionViewStreamHub.publish(streamKey, { type: "status", running: false });
        return;
      }
      const model = loadSessionViewModel(targetSessionFile);
      sessionViewStreamHub.publish(streamKey, {
        type: "refresh",
        timelineHtml: renderTimelineItems(model.items, token),
        updatedAt: formatDate(model.updatedAt),
        entryCount: model.entryCount,
        running: false,
      });
    })
    .catch((error) => {
      log.logWarning(
        `[${entry.conversationId}] Session view message failed`,
        error instanceof Error ? error.message : String(error),
      );
      reportUserFacingError(error, {
        domain: "session_view",
        surface: "session_view",
        operation: "interactive_message",
        severity: "error",
        platform: entry.platform,
        context: {
          conversationId: entry.conversationId,
          sessionKey: activeSessionKey,
          messageId: ts,
          textLength: text.length,
        },
      });
      sessionViewStreamHub.publish(streamKey, {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      sessionViewStreamHub.publish(streamKey, { type: "status", running: false });
    });

  json(res, 202, { ok: true, accepted: true });
}

function createSessionViewResponseContext(
  publish: (event: SessionStreamEvent) => void,
): ConversationResponder {
  let accumulatedText = "";

  return {
    respond: async (text: string) => {
      accumulatedText = accumulatedText ? `${accumulatedText}\n${text}` : text;
      publish({ type: "assistant", html: renderLiveAssistantMessage(accumulatedText) });
    },
    replaceResponse: async (text: string) => {
      accumulatedText = text;
      publish({ type: "assistant", html: renderLiveAssistantMessage(accumulatedText) });
    },
    respondDiagnostic: async (text: string, options?: { style?: "muted" | "error" }) => {
      if (options?.style === "error") {
        publish({ type: "system", html: renderLiveSystemEvent(text, "err") });
      }
    },
    respondToolResult: async (result) => {
      publish({ type: "tool", html: renderLiveToolResult(result) });
    },
    setTyping: async () => {
      publish({ type: "status", running: true });
    },
    setWorking: async (working: boolean) => {
      publish({ type: "status", running: working });
    },
    uploadFile: async () => {},
    deleteResponse: async () => {
      accumulatedText = "";
      publish({ type: "assistant_remove" });
    },
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function renderStatusPage(title: string, message: string): string {
  return renderHtmlDocument(
    title,
    `<section class="card stack">
      <p class="eyebrow">mikan</p>
      <h1 class="page-title">${esc(title)}</h1>
      <div class="status err">${esc(message)}</div>
    </section>`,
    false,
  );
}

function renderHtmlDocument(title: string, shellContent: string, isRunning: boolean): string {
  return renderPortalShell({
    activeView: "session",
    pageTitle: "Session",
    body: shellContent,
    extraStyles: sessionViewStyles,
    bodyAttributes: { "data-session-running": isRunning ? "true" : "false" },
    inlineScript: sessionViewScript,
  });
}

const sessionViewScript = `
    const form = document.querySelector('[data-session-composer]');
    const timelineList = document.querySelector('[data-timeline-list]');
    const jumpLatestBtn = document.querySelector('[data-jump-latest]');
    const statusEl = document.querySelector('[data-session-status]');
    const updatedEl = document.querySelector('[data-session-updated]');
    const entriesEl = document.querySelector('[data-session-entries]');
    const composerStatus = form?.querySelector('[data-composer-status]');
    const textarea = form?.querySelector('textarea[name="text"]');
    const submitButton = form?.querySelector('button[type="submit"]');
    let liveAssistant = null;
    let running = document.body.dataset.sessionRunning === 'true';

    const isNearMessagingBottom = () => window.innerHeight + window.scrollY >= document.body.offsetHeight - 120;
    const scrollToLatest = (behavior = 'smooth') => window.scrollTo({ top: document.body.scrollHeight, behavior });
    const toggleJumpButton = () => {
      if (!jumpLatestBtn) return;
      jumpLatestBtn.hidden = isNearMessagingBottom();
    };
    const updateFollowState = () => {
      if (isNearMessagingBottom()) scrollToLatest('smooth');
      else toggleJumpButton();
    };
    const canSubmit = () => Boolean(textarea && textarea.value.trim()) && !running;
    const updateSubmitButtonState = () => {
      if (submitButton) submitButton.disabled = !canSubmit();
    };
    const setRunning = (value) => {
      running = value;
      document.body.dataset.sessionRunning = value ? 'true' : 'false';
      if (statusEl) statusEl.textContent = value ? 'Running' : 'Idle';
      updateSubmitButtonState();
      if (composerStatus && !value && composerStatus.textContent === 'Thinking…') {
        composerStatus.textContent = '';
      }
    };

    jumpLatestBtn?.addEventListener('click', () => {
      scrollToLatest('smooth');
      toggleJumpButton();
    });
    document.addEventListener('click', async (event) => {
      const button = event.target instanceof Element ? event.target.closest('[data-copy-button]') : null;
      if (!(button instanceof HTMLButtonElement)) return;
      const label = button.dataset.copyLabel || 'Copy message';
      const source = button.closest('.msg-actions')?.previousElementSibling;
      const text = source instanceof HTMLElement ? (source.innerText || source.textContent || '').trim() : '';
      if (!text) return;
      const setState = (state, transient) => {
        button.dataset.copyState = state;
        button.title = transient;
        button.setAttribute('aria-label', transient);
        window.setTimeout(() => {
          if (!button.isConnected) return;
          delete button.dataset.copyState;
          button.title = label;
          button.setAttribute('aria-label', label);
        }, 1200);
      };
      try {
        await navigator.clipboard.writeText(text);
        setState('done', 'Copied');
      } catch {
        setState('error', 'Copy failed');
      }
    });
    window.addEventListener('scroll', toggleJumpButton, { passive: true });

    if (textarea) {
      const resize = () => {
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 240) + 'px';
      };
      textarea.addEventListener('input', () => {
        resize();
        updateSubmitButtonState();
      });
      textarea.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || event.shiftKey) return;
        if (event.isComposing || event.keyCode === 229) return;
        event.preventDefault();
        if (!running) form?.requestSubmit();
      });
      resize();
    }

    setRunning(running);
    updateSubmitButtonState();

    const streamUrl = form
      ? '/session/stream?token=' + encodeURIComponent(form.token.value) + '&session=' + encodeURIComponent(form.session.value)
      : null;
    if (streamUrl) {
      const source = new EventSource(streamUrl);
      source.onmessage = (event) => {
        const payload = JSON.parse(event.data);
        switch (payload.type) {
          case 'status':
            setRunning(Boolean(payload.running));
            if (payload.running && composerStatus) composerStatus.textContent = 'Thinking…';
            break;
          case 'user':
          case 'tool':
          case 'system': {
            timelineList?.insertAdjacentHTML('beforeend', payload.html);
            updateFollowState();
            break;
          }
          case 'assistant': {
            if (!liveAssistant || !liveAssistant.isConnected) {
              timelineList?.insertAdjacentHTML('beforeend', payload.html);
              liveAssistant = timelineList?.querySelector('[data-live-assistant]:last-of-type') || null;
            } else {
              liveAssistant.outerHTML = payload.html;
              liveAssistant = timelineList?.querySelector('[data-live-assistant]:last-of-type') || null;
            }
            updateFollowState();
            break;
          }
          case 'assistant_remove':
            if (liveAssistant?.isConnected) liveAssistant.remove();
            liveAssistant = null;
            break;
          case 'refresh':
            if (timelineList) timelineList.innerHTML = payload.timelineHtml;
            liveAssistant = null;
            if (updatedEl) updatedEl.textContent = payload.updatedAt;
            if (entriesEl) entriesEl.textContent = String(payload.entryCount);
            setRunning(Boolean(payload.running));
            if (composerStatus) composerStatus.textContent = '';
            updateFollowState();
            break;
          case 'error':
            if (composerStatus) composerStatus.textContent = payload.message || 'Something went wrong';
            setRunning(false);
            break;
        }
      };
    }

    form?.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!textarea || !composerStatus) return;
      const text = textarea.value.trim();
      if (!text || running) return;
      composerStatus.textContent = 'Sending…';
      updateSubmitButtonState();
      try {
        const response = await fetch('/session/message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: form.token.value, session: form.session.value, sessionKey: form.sessionKey.value, text }),
        });
        const payload = await response.json();
        if (!response.ok || !payload.ok) throw new Error(payload.error || 'Request failed');
        textarea.value = '';
        textarea.style.height = 'auto';
        composerStatus.textContent = 'Thinking…';
        setRunning(true);
        updateSubmitButtonState();
        scrollToLatest('smooth');
      } catch (err) {
        composerStatus.textContent = err && err.message ? err.message : String(err);
        submitButton.disabled = false;
      }
    });

    toggleJumpButton();
`;

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

const esc = escapeHtml;

const sessionViewStyles = `
  :root {
    --user-bg: #18181b;
    --user-text: #fafafa;
    --user-time: rgba(250, 250, 250, 0.5);

    --asst-border: #22c55e;
    --asst-avatar-bg: #f0fdf4;
    --asst-avatar-text: #16a34a;

    --tool-bg: #0d1117;
    --tool-header: #161b22;
    --tool-text: #c9d1d9;
    --tool-accent: #58a6ff;
    --tool-ok: #3fb950;
    --tool-err: #f85149;
    --tool-time: #484f58;
  }

  body {
    /* Extra bottom padding for the fixed composer */
    padding-bottom: calc(140px + env(safe-area-inset-bottom, 0px));
    overflow-x: hidden;
  }

  /* ── Session-specific page-head extras ─────────────────────────────── */

  .session-side {
    display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
    flex-shrink: 0;
  }
  .session-badge {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 6px 11px; border: 1px solid var(--border); border-radius: 999px;
    background: rgba(255,255,255,0.7); font-size: 0.78rem; color: var(--muted);
    line-height: 1;
  }
  .session-badge strong { color: var(--text); font-weight: 600; }
  .session-badge-status.is-running {
    background: #fff7ed; border-color: rgba(217, 119, 6, 0.18); color: #9a3412;
  }
  .session-badge-dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: #a1a1aa; flex-shrink: 0;
  }
  .session-badge-status.is-running .session-badge-dot {
    background: #d97706; box-shadow: 0 0 0 4px rgba(217, 119, 6, 0.14);
  }

  .session-detail-row {
    display: flex; flex-wrap: wrap; gap: 8px;
    padding: 12px 14px; border: 1px solid var(--border); border-radius: 14px;
    background: rgba(255,255,255,0.6);
  }
  .session-detail {
    display: inline-flex; align-items: center; gap: 8px; min-width: 0;
    padding: 4px 10px; border-radius: 10px; background: rgba(0, 0, 0, 0.025);
    color: var(--muted); font-size: 0.78rem;
  }
  .session-detail-label {
    text-transform: uppercase; letter-spacing: 0.08em;
    font-size: 0.68rem; color: var(--subtle);
  }
  .session-detail code {
    min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.74rem;
    color: var(--text); padding: 0;
  }

  /* ── Timeline shell ───────────────────────────────────────────────────── */

  .thread-links {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 10px;
  }

  .thread-link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    border-radius: 999px;
    border: 1px solid rgba(239, 68, 68, 0.18);
    background: rgba(254, 242, 242, 0.95);
    color: #b91c1c;
    text-decoration: none;
    font-size: 0.74rem;
    font-weight: 600;
    line-height: 1;
    transition: transform 120ms, background 120ms, border-color 120ms;
  }

  .thread-link:hover {
    transform: translateY(-1px);
    background: #fff1f2;
    border-color: rgba(239, 68, 68, 0.28);
  }

  .thread-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #ef4444;
    box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.12);
    flex-shrink: 0;
  }

  .thread-text {
    white-space: nowrap;
  }

  .related-card {
    padding: 18px 20px;
    border: 1px solid var(--border);
    border-radius: 18px;
    background: rgba(255,255,255,0.78);
    box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.04);
    backdrop-filter: blur(12px);
  }

  .related-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .related-link {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 14px;
    border-radius: 14px;
    border: 1px solid var(--border);
    background: rgba(255,255,255,0.82);
    color: inherit;
    text-decoration: none;
    transition: transform 120ms, border-color 120ms, box-shadow 120ms, background 120ms;
  }

  .related-link:hover {
    transform: translateY(-1px);
    border-color: rgba(0,0,0,0.16);
    background: #fff;
    box-shadow: 0 8px 18px rgba(0,0,0,0.05);
  }

  .related-copy {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .related-title {
    color: var(--text);
    font-size: 0.94rem;
    line-height: 1.3;
  }

  .related-summary {
    color: var(--muted);
    font-size: 0.82rem;
    line-height: 1.45;
  }

  .related-meta {
    color: var(--subtle);
    font-size: 0.74rem;
    line-height: 1.4;
  }

  .related-arrow {
    flex-shrink: 0;
    color: var(--subtle);
    font-size: 1rem;
  }

  .timeline-shell {
    padding: 20px 0;
  }

  .timeline-list {
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-width: 0;
  }

  .copy-host {
    position: relative;
  }

  .msg-actions {
    height: 32px;
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
    opacity: 0;
    visibility: hidden;
    transition: opacity 140ms ease, visibility 140ms ease;
  }

  .copy-host:hover .msg-actions,
  .copy-host .msg-actions:hover,
  .copy-host:focus-within .msg-actions,
  .timeline-list > .copy-host:last-child .msg-actions,
  .copy-action-btn[data-copy-state] {
    opacity: 1;
    visibility: visible;
  }

  .copy-action-btn {
    width: 24px;
    height: 24px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: rgba(63,63,70,0.8);
    transition: color 140ms ease, opacity 140ms ease;
    cursor: pointer;
    padding: 0;
    appearance: none;
  }

  .copy-action-btn:hover {
    background: transparent;
    color: rgba(24,24,27,0.96);
    border-color: transparent;
  }

  .copy-action-btn[data-copy-state='done'] {
    background: transparent;
    border-color: transparent;
    color: rgba(24,24,27,0.96);
  }

  .copy-action-btn[data-copy-state='done'] svg {
    position: absolute;
    opacity: 0;
    transform: scale(0.6);
    pointer-events: none;
  }

  .copy-action-btn svg {
    transition: opacity 140ms ease, transform 140ms ease;
  }

  .copy-action-btn[data-copy-state='done']::before {
    content: '';
    width: 14px;
    height: 14px;
    background-color: currentColor;
    -webkit-mask: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'><polyline points='4 12 10 18 20 6'/></svg>") center / contain no-repeat;
            mask: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'><polyline points='4 12 10 18 20 6'/></svg>") center / contain no-repeat;
    animation: copy-check-in 200ms ease-out both;
  }

  @keyframes copy-check-in {
    from { opacity: 0; transform: scale(0.6); }
    to { opacity: 1; transform: scale(1); }
  }

  @media (prefers-reduced-motion: reduce) {
    .copy-action-btn svg,
    .copy-action-btn[data-copy-state='done']::before {
      transition: none;
      animation: none;
    }
  }

  .copy-action-btn[data-copy-state='error'] {
    background: transparent;
    border-color: transparent;
    color: #b91c1c;
  }

  /* ── Message rows ─────────────────────────────────────────────────────── */

  .msg-row {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    padding: 4px 0;
    min-width: 0;
  }

  /* ── User messages ────────────────────────────────────────────────────── */

  .msg-user {
    justify-content: flex-end;
  }

  .msg-main {
    min-width: 0;
  }

  .user-main {
    max-width: 85%;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
  }

  .user-bubble {
    max-width: 100%;
    min-width: 0;
    padding: 12px 16px;
    border-radius: 18px 18px 4px 18px;
    background: var(--user-bg);
    color: var(--user-text);
    box-shadow: 0 1px 2px rgba(0,0,0,0.12);
  }

  .msg-raw-header {
    margin-bottom: 8px;
    color: rgba(250, 250, 250, 0.72);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 0.72rem;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .thread-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 8px;
    padding: 4px 10px;
    border-radius: 999px;
    background: rgba(255,255,255,0.22);
    color: var(--user-text);
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.01em;
  }

  .thread-badge code {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 0.66rem;
    background: rgba(255,255,255,0.16);
    padding: 1px 6px;
    border-radius: 999px;
    color: inherit;
  }

  .msg-user .msg-body {
    color: var(--user-text);
  }

  .msg-user .msg-time {
    display: block;
    margin-top: 6px;
    font-size: 0.72rem;
    color: var(--user-time);
    text-align: right;
  }

  /* ── Avatars ──────────────────────────────────────────────────────────── */

  .msg-avatar {
    flex: 0 0 28px;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    font-size: 0.68rem;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
    letter-spacing: 0;
    flex-shrink: 0;
  }

  .user-avatar {
    background: #eff6ff;
    border: 1.5px solid #93c5fd;
    color: #1d4ed8;
  }

  .asst-avatar {
    background: var(--asst-avatar-bg);
    border: 1.5px solid var(--asst-border);
    color: var(--asst-avatar-text);
    margin-bottom: 2px;
  }

  /* ── Assistant messages ───────────────────────────────────────────────── */

  .msg-assistant {
    align-items: flex-end;
    gap: 8px;
    max-width: 85%;
    min-width: 0;
  }

  .asst-main {
    max-width: 100%;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
  }

  .asst-card {
    min-width: 0;
    max-width: 100%;
    padding: 14px 18px;
    border: 1px solid var(--border);
    border-radius: 18px 18px 18px 4px;
    background: var(--surface);
    box-shadow: 0 1px 3px rgba(0,0,0,0.04);
  }

  .msg-assistant .msg-body {
    color: var(--text);
  }

  .msg-assistant .msg-time {
    display: block;
    margin-top: 8px;
    font-size: 0.72rem;
    color: var(--subtle);
  }

  /* ── Tool blocks ──────────────────────────────────────────────────────── */

  .tool-block {
    max-width: 92%;
    margin-left: 36px;
    border-radius: 10px;
    overflow: hidden;
    border: 1px solid rgba(255,255,255,0.06);
    box-shadow: 0 2px 8px rgba(0,0,0,0.16);
    margin: 2px 0;
  }

  .tool-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    background: var(--tool-header);
    border-bottom: 1px solid rgba(255,255,255,0.06);
    overflow: hidden;
  }

  .tool-icon {
    color: var(--tool-accent);
    flex-shrink: 0;
    display: flex;
    align-items: center;
  }

  .tool-name {
    flex: 1;
    font-family: 'JetBrains Mono', 'Fira Code', ui-monospace, monospace;
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--tool-accent);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .tool-time {
    flex-shrink: 0;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 0.7rem;
    color: var(--tool-time);
  }

  .tool-output {
    display: block;
    padding: 12px 14px;
    background: var(--tool-bg);
    color: var(--tool-text);
    font-family: 'JetBrains Mono', 'Fira Code', ui-monospace, monospace;
    font-size: 0.78rem;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
    overflow-x: auto;
    max-height: 400px;
    overflow-y: auto;
  }

  .tool-output.tone-ok { color: var(--tool-ok); }
  .tool-output.tone-err { color: var(--tool-err); }

  /* ── Markdown blocks ──────────────────────────────────────────────────── */

  .markdown-body {
    font-family: 'DM Sans', system-ui, sans-serif;
    font-size: 0.9rem;
    line-height: 1.65;
    word-break: break-word;
  }

  .markdown-body > *:first-child { margin-top: 0; }
  .markdown-body > *:last-child { margin-bottom: 0; }
  .markdown-body p,
  .markdown-body ul,
  .markdown-body ol,
  .markdown-body blockquote,
  .markdown-body pre,
  .markdown-body table,
  .markdown-body hr {
    margin: 0 0 0.85em;
  }

  .markdown-body h1,
  .markdown-body h2,
  .markdown-body h3,
  .markdown-body h4,
  .markdown-body h5,
  .markdown-body h6 {
    margin: 0 0 0.55em;
    line-height: 1.25;
    font-weight: 700;
    letter-spacing: -0.01em;
  }

  .markdown-body h1 { font-size: 1.4rem; }
  .markdown-body h2 { font-size: 1.22rem; }
  .markdown-body h3 { font-size: 1.08rem; }
  .markdown-body h4,
  .markdown-body h5,
  .markdown-body h6 { font-size: 0.95rem; }

  .markdown-body ul,
  .markdown-body ol {
    padding-left: 1.3em;
  }

  .markdown-body li + li {
    margin-top: 0.22em;
  }

  .markdown-body blockquote {
    padding-left: 12px;
    border-left: 3px solid rgba(34, 197, 94, 0.35);
    opacity: 0.95;
  }

  .markdown-body a {
    color: inherit;
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .markdown-body code {
    font-family: 'JetBrains Mono', 'Fira Code', ui-monospace, monospace;
    font-size: 0.82em;
    padding: 0.16em 0.38em;
    border-radius: 6px;
  }

  .markdown-body pre {
    overflow-x: auto;
    border-radius: 12px;
    padding: 12px 14px;
  }

  .markdown-body pre code {
    display: block;
    padding: 0;
    border-radius: 0;
    background: transparent;
    font-size: 0.82rem;
    line-height: 1.6;
  }

  .markdown-body table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.85rem;
  }

  .markdown-body th,
  .markdown-body td {
    padding: 8px 10px;
    border: 1px solid rgba(0, 0, 0, 0.08);
    text-align: left;
    vertical-align: top;
  }

  .markdown-body img {
    max-width: 100%;
    border-radius: 12px;
  }

  .markdown-user code {
    background: rgba(255,255,255,0.14);
    color: var(--user-text);
  }

  .markdown-user pre {
    background: rgba(255,255,255,0.08);
    border: 1px solid rgba(255,255,255,0.08);
  }

  .markdown-user table th,
  .markdown-user table td {
    border-color: rgba(255,255,255,0.16);
  }

  .markdown-assistant code {
    background: #f4f4f5;
    color: #27272a;
  }

  .markdown-assistant pre {
    background: #0f172a;
    color: #e5e7eb;
  }

  .markdown-assistant pre code {
    background: transparent;
    color: inherit;
  }

  .markdown-assistant table th,
  .markdown-assistant table td {
    border-color: rgba(0, 0, 0, 0.08);
  }

  /* ── System events ────────────────────────────────────────────────────── */

  .system-event {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 10px 0;
    color: var(--subtle);
    font-size: 0.775rem;
  }

  .event-dot {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--subtle);
    flex-shrink: 0;
    opacity: 0.6;
  }

  .event-text {
    color: var(--muted);
  }

  .system-event-err .event-text {
    color: var(--err-text);
  }

  .event-time {
    color: var(--subtle);
    font-style: normal;
  }

  /* ── Status page ──────────────────────────────────────────────────────── */

  .stack > * + * { margin-top: 14px; }

  p { color: var(--muted); font-size: 0.9rem; line-height: 1.5; }

  .status {
    padding: 12px 16px;
    border-radius: 10px;
    font-size: 0.9rem;
  }

  .status.err {
    background: var(--err-bg);
    color: var(--err-text);
    border: 1px solid rgba(185, 28, 28, 0.12);
  }

  /* ── Composer ─────────────────────────────────────────────────────────── */

  .composer-card {
    position: fixed;
    left: calc(72px + (100vw - 72px) / 2);
    bottom: calc(16px + env(safe-area-inset-bottom, 0px));
    transform: translateX(-50%);
    width: min(960px, calc(100vw - 96px));
    padding: 10px 12px 10px 14px;
    border: 1px solid var(--border);
    border-radius: 22px;
    background: rgba(250, 248, 244, 0.92);
    box-shadow: 0 12px 36px rgba(0,0,0,0.10), 0 2px 6px rgba(0,0,0,0.04);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    z-index: 20;
  }

  .composer-form {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .jump-latest-btn {
    position: fixed;
    left: calc(72px + (100vw - 72px) / 2);
    bottom: calc(env(safe-area-inset-bottom, 0px) + 120px);
    z-index: 25;
    width: 42px;
    height: 42px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--bg);
    color: var(--text);
    font: 700 1rem/1 'DM Sans', sans-serif;
    box-shadow: 0 10px 30px rgba(0,0,0,0.12);
    cursor: pointer;
    backdrop-filter: blur(10px);
    transform: translateX(-50%);
    outline: none;
    appearance: none;
    -webkit-tap-highlight-color: transparent;
  }

  .jump-latest-btn:hover {
    transform: translateX(-50%) translateY(-1px);
    background: #e8e3d9;
  }

  .jump-latest-btn:focus,
  .jump-latest-btn:active {
    outline: none;
  }

  .jump-latest-btn:focus-visible {
    box-shadow: 0 10px 30px rgba(0,0,0,0.12), 0 0 0 3px rgba(0,0,0,0.08);
  }

  .composer-copy { margin-bottom: 12px; color: var(--muted); }

  .composer-form textarea {
    width: 100%;
    resize: none;
    overflow-y: auto;
    min-height: 28px;
    max-height: 200px;
    padding: 6px 6px 2px;
    border: 0;
    border-radius: 0;
    font: inherit;
    color: var(--text);
    background: transparent;
  }

  .composer-form textarea::placeholder {
    color: rgba(63,63,70,0.55);
  }

  .composer-form textarea:focus {
    outline: none;
    border: 0;
  }

  .composer-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-top: 0;
  }

  .composer-status { color: var(--muted); font-size: 13px; }
  .composer-actions button:disabled { opacity: 0.55; cursor: wait; }

  .composer-send-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: none;
    border-radius: 999px;
    background: #d97706;
    color: #ffffff;
    font: 700 1rem/1 'DM Sans', sans-serif;
    cursor: pointer;
    box-shadow: 0 10px 24px rgba(217, 119, 6, 0.26);
    transition: transform 120ms, filter 120ms, box-shadow 120ms, background 120ms;
  }

  .composer-send-btn:hover:not(:disabled) {
    transform: translateY(-1px);
    filter: saturate(1.06) brightness(0.98);
    box-shadow: 0 12px 28px rgba(217, 119, 6, 0.32);
  }

  .composer-send-btn:focus-visible {
    outline: 2px solid rgba(217, 119, 6, 0.28);
    outline-offset: 3px;
  }

  .composer-send-btn:disabled {
    background: #d4d4d8;
    color: rgba(24, 24, 27, 0.45);
    box-shadow: none;
    transform: none;
    filter: none;
    cursor: not-allowed;
    opacity: 1;
  }

  /* ── Responsive ───────────────────────────────────────────────────────── */

  @media (max-width: 900px) {
    .composer-card {
      left: 50%;
      width: min(960px, calc(100vw - 24px));
    }
    .jump-latest-btn { left: 50%; }
  }

  @media (max-width: 600px) {
    body { padding-bottom: calc(130px + env(safe-area-inset-bottom, 0px)); }

    .composer-card {
      width: calc(100vw - 16px);
      bottom: calc(8px + env(safe-area-inset-bottom, 0px));
      padding: 8px 10px;
      border-radius: 18px;
    }

    .session-side { align-items: flex-start; flex-direction: row; }

    .user-bubble,
    .msg-assistant,
    .tool-block { max-width: 100%; }

    .asst-avatar { display: none; }

    .asst-card { border-radius: 4px 14px 14px 14px; }
  }
`;
