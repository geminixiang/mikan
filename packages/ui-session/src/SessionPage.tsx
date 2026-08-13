import { useCallback, useEffect, useRef, useState } from "react";
import { marked } from "marked";
import type {
  SessionViewApiResponse,
  SessionViewItem,
  SessionViewRelation,
} from "@geminixiang/mikan-daemon-web-bridge";
import { apiGet, apiPost, queryParam } from "@geminixiang/mikan-web-client";
import "./session.css";

marked.setOptions({ gfm: true, breaks: true });

/** Escape raw HTML so it renders as text (the server portal used html:false). */
function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderMarkdown(text: string): string {
  return marked.parse(escapeHtml(text), { async: false }) as string;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface ParsedUserBody {
  timestamp: string | null;
  username: string | null;
  threadTs: string | null;
  content: string;
}

/** Parse the history-sync header baked into user-message bodies. */
function parseUserBody(raw: string): ParsedUserBody {
  const m = raw.match(
    /^\[([0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}[+-][0-9]{2}:[0-9]{2})\]\s*\[([^\]]+)\](?:\s*\[in-thread:([^\]]+)\])?:\s*([\s\S]*)$/,
  );
  if (!m) return { timestamp: null, username: null, threadTs: null, content: raw };
  return {
    timestamp: m[1] ?? null,
    username: m[2] ?? null,
    threadTs: m[3] ?? null,
    content: m[4] ?? "",
  };
}

function ThreadChips({ relations, token }: { relations?: SessionViewRelation[]; token: string }) {
  if (!relations || relations.length === 0) return null;
  return (
    <div className="thread-links">
      {relations.map((r) => (
        <a
          key={r.fileName}
          className="thread-link"
          href={`/session?token=${encodeURIComponent(token)}&session=${encodeURIComponent(r.fileName)}`}
          title={`Open ${r.title}`}
        >
          <span className="thread-dot" aria-hidden="true" />
          <span className="thread-text">Thread</span>
        </a>
      ))}
    </div>
  );
}

function TimelineItem({ item, token }: { item: SessionViewItem; token: string }) {
  if (item.kind === "system") {
    return (
      <div className="system-event">
        <span className="event-dot" />
        <span className="event-text">
          <span className="event-title">{item.title}</span>
          {item.body ? <span className="event-body">{renderMarkdown(item.body)}</span> : null}
        </span>
      </div>
    );
  }

  if (item.kind === "user") {
    const parsed = parseUserBody(item.body ?? "");
    return (
      <div className="msg-row user-row">
        <div className="msg-avatar" aria-hidden="true" />
        <div className="msg-bubble user-bubble">
          {parsed.timestamp && parsed.username ? (
            <div className="user-header">
              <span className="user-name">{parsed.username}</span>
              {parsed.threadTs ? <span className="thread-badge">in-thread</span> : null}
              <span className="user-time">{parsed.timestamp}</span>
            </div>
          ) : null}
          <div
            className="markdown"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(parsed.content) }}
          />
          <ThreadChips relations={item.threads} token={token} />
        </div>
      </div>
    );
  }

  if (item.kind === "tool") {
    return (
      <div
        className={`tool-block ${item.tone === "err" ? "tool-err" : item.tone === "ok" ? "tool-ok" : ""}`}
      >
        <div className="tool-head">
          <span className="tool-title">{item.title}</span>
          {item.meta ? <span className="tool-meta">{item.meta}</span> : null}
        </div>
        {item.body ? <pre className="tool-output">{item.body}</pre> : null}
      </div>
    );
  }

  return (
    <div className="msg-row assistant-row">
      <div className="msg-avatar" aria-hidden="true" />
      <div className="msg-bubble assistant-bubble">
        {item.body ? (
          <div
            className="markdown"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(item.body) }}
          />
        ) : null}
        {item.meta ? <div className="assistant-meta">{item.meta}</div> : null}
      </div>
    </div>
  );
}

function RelationCard({ relation, token }: { relation: SessionViewRelation; token: string }) {
  const href = `/session?token=${encodeURIComponent(token)}&session=${encodeURIComponent(relation.fileName)}`;
  return (
    <a className="related-link" href={href}>
      <span className="related-copy">
        <strong className="related-title">{relation.title}</strong>
        {relation.summary ? <span className="related-summary">{relation.summary}</span> : null}
        <span className="related-meta">
          {formatDate(relation.updatedAt)} · {relation.entryCount} entries · {relation.fileName}
        </span>
      </span>
      <span className="related-arrow" aria-hidden="true">
        →
      </span>
    </a>
  );
}

function SessionHeader({ data, token }: { data: SessionViewApiResponse; token: string }) {
  const { model } = data;
  const isThread = data.displayedSessionKey !== data.conversationId;
  return (
    <>
      <header className="page-head">
        <div>
          <p className="eyebrow">Session</p>
          <h2 className="page-title">{model.title}</h2>
          <p className="page-desc">
            <span>Created {formatDate(model.createdAt)}</span> ·{" "}
            <span>
              Updated <strong>{formatDate(model.updatedAt)}</strong>
            </span>{" "}
            · <span>{model.entryCount} entries</span>
          </p>
        </div>
        <div className="session-side">
          <span
            className={`session-badge session-badge-status${data.isRunning ? " is-running" : ""}`}
          >
            <span className="session-badge-dot" />
            <strong>{data.isRunning ? "Running" : "Idle"}</strong>
          </span>
          <span className="session-badge">{isThread ? "Thread" : "Channel"}</span>
        </div>
      </header>
      <div className="session-detail-row">
        <span className="session-detail">
          <span className="session-detail-label">Session</span>
          <code>{model.sessionId.slice(0, 8)}</code>
        </span>
        <span className="session-detail">
          <span className="session-detail-label">File</span>
          <code>{model.fileName}</code>
        </span>
        <span className="session-detail">
          <span className="session-detail-label">Expires</span>
          <span>{formatDate(new Date(data.expiresAt).toISOString())}</span>
        </span>
      </div>
      {model.parent ? (
        <section className="related-card card">
          <p className="eyebrow">Parent session</p>
          <RelationCard relation={model.parent} token={token} />
        </section>
      ) : null}
    </>
  );
}

function SessionComposer({
  data,
  token,
  sending,
  status,
  onSubmit,
}: {
  data: SessionViewApiResponse;
  token: string;
  sending: boolean;
  status: string | null;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <section className="composer-card">
      <form className="composer-form" onSubmit={onSubmit}>
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="session" value={data.model.fileName} />
        <textarea
          name="text"
          rows={1}
          placeholder="Ask mikan in this session… (replies stay in Session View)"
          required
        />
        <div className="composer-actions">
          <span className="composer-status">{status}</span>
          <button
            className="composer-send-btn"
            type="submit"
            aria-label="Send"
            title="Send"
            disabled={sending}
          >
            ↑
          </button>
        </div>
      </form>
    </section>
  );
}

/**
 * Live updates: the existing /session/stream SSE already emits JSON events;
 * any of them can change the model, so re-fetch (debounced) on each event and
 * apply running-status frames immediately.
 */
function useSessionStream(
  token: string,
  session: string,
  data: SessionViewApiResponse | null,
  load: () => Promise<void>,
  setData: (
    updater: (prev: SessionViewApiResponse | null) => SessionViewApiResponse | null,
  ) => void,
): void {
  useEffect(() => {
    if (!token) return;
    const params = new URLSearchParams({ token });
    if (session) params.set("session", session);
    const source = new EventSource(`/session/stream?${params.toString()}`);
    let timer: number | undefined;
    const scheduleReload = (): void => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(), 250);
    };
    source.addEventListener("status", (event) => {
      try {
        const status = JSON.parse((event as MessageEvent).data) as { running?: boolean };
        const running = status.running;
        if (running !== undefined && data) {
          setData((prev) => (prev ? { ...prev, isRunning: running } : prev));
        }
      } catch {
        // malformed frame; ignore
      }
      scheduleReload();
    });
    source.addEventListener("message", scheduleReload);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      source.close();
    };
  }, [token, session, load, data, setData]);
}

export function SessionPage() {
  const [data, setData] = useState<SessionViewApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [composerStatus, setComposerStatus] = useState<string | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

  const token = queryParam("token") ?? "";
  const session = queryParam("session") ?? "";

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ token });
      if (session) params.set("session", session);
      const response = await apiGet<SessionViewApiResponse>(
        `/api/session/view?${params.toString()}`,
      );
      setData(response);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [token, session]);

  useEffect(() => {
    void load();
  }, [load]);

  useSessionStream(token, session, data, load, setData);

  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const text = String(formData.get("text") ?? "").trim();
    if (!text || !data || sending) return;
    setSending(true);
    setComposerStatus("Sending…");
    apiPost("/session/message", {
      token,
      session: data.model.fileName,
      sessionKey: data.displayedSessionKey,
      text,
    })
      .then(async () => {
        setComposerStatus("Sent — waiting for the bot…");
        form.reset();
        await load();
      })
      .catch((err: unknown) => {
        setComposerStatus(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setSending(false));
  };

  if (error) {
    return (
      <div className="card">
        <p className="eyebrow">Session</p>
        <h2 className="card-title">Session unavailable</h2>
        <div className="err-msg">{error}</div>
      </div>
    );
  }

  if (!data) return <div className="loading-msg">Loading session…</div>;

  return (
    <>
      <SessionHeader data={data} token={token} />
      <div className="timeline-shell">
        <div className="timeline-list" ref={timelineRef}>
          {data.model.items.length > 0 ? (
            data.model.items.map((item, index) => (
              <TimelineItem key={item.entryId ?? index} item={item} token={token} />
            ))
          ) : (
            <div className="empty-state">No messages yet — send one to the bot, then refresh.</div>
          )}
        </div>
      </div>
      <SessionComposer
        data={data}
        token={token}
        sending={sending}
        status={composerStatus}
        onSubmit={submit}
      />
    </>
  );
}
