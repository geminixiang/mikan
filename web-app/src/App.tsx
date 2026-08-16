import { useEffect, useReducer, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { WebAccount, WebIdentityProvider } from "../../src/web/auth/types.js";
import type {
  WebSessionHistory,
  WebSessionSummary,
  WebToolSnapshot,
  WebWorkspace,
} from "../../src/web/harness/protocol.js";
import { ApiError, WebApi } from "./api.js";
import {
  initialLiveState,
  liveReducer,
  oauthErrorFromLocation,
  readWorkspaceRoute,
  workspaceRoute,
} from "./state.js";

interface AuthenticatedState {
  readonly account: WebAccount;
  readonly expiresAt: number;
}

const api = new WebApi();

export function App() {
  const [auth, setAuth] = useState<AuthenticatedState | null | undefined>(undefined);
  const [providers, setProviders] = useState<readonly WebIdentityProvider[]>([]);
  const [workspaces, setWorkspaces] = useState<readonly WebWorkspace[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<readonly WebSessionSummary[]>([]);
  const [selectedSession, setSelectedSession] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(() => oauthErrorFromLocation(window.location));
  const [busy, setBusy] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [live, dispatch] = useReducer(liveReducer, initialLiveState);
  const previousRun = useRef(live.run);

  useEffect(() => {
    void bootstrap();
    async function bootstrap() {
      try {
        const session = await api.loadSession();
        api.setSession(session);
        if (!session) {
          setProviders(await api.loadProviders());
          setAuth(null);
          return;
        }
        setAuth({ account: session.account, expiresAt: session.expiresAt });
        const owned = await api.listWorkspaces();
        setWorkspaces(owned);
        const routed = readWorkspaceRoute(window.location.pathname);
        const selected = owned.find((item) => item.id === routed)?.id ?? owned[0]?.id ?? null;
        setSelectedId(selected);
        if (selected) replaceWorkspaceUrl(selected);
      } catch (caught) {
        setError(messageOf(caught));
        setAuth(null);
      }
    }
  }, []);

  useEffect(() => {
    if (!auth || !selectedId) return;
    let closed = false;
    let reconnectTimer: number | undefined;
    let reconnectAttempt = 0;
    let source: EventSource | null = null;

    dispatch({ type: "reset" });
    setSelectedSession(undefined);
    void reloadWorkspace(selectedId);
    connect();
    window.addEventListener("online", recoverConnection);
    document.addEventListener("visibilitychange", recoverConnection);

    function recoverConnection() {
      if (closed || !navigator.onLine || document.visibilityState === "hidden") return;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      source?.close();
      reconnectTimer = undefined;
      connect();
    }

    function connect() {
      if (closed) return;
      dispatch({ type: "connection", status: "connecting" });
      const nextSource = api.stream(selectedId!, (frame) => dispatch({ type: "frame", frame }));
      source = nextSource;
      nextSource.addEventListener("open", () => {
        reconnectAttempt = 0;
        dispatch({ type: "connection", status: "open" });
      });
      nextSource.addEventListener("error", () => {
        nextSource.close();
        dispatch({ type: "connection", status: "closed" });
        const delay = Math.min(15_000, 500 * 2 ** reconnectAttempt++);
        reconnectTimer = window.setTimeout(connect, delay);
      });
    }

    async function reloadWorkspace(workspaceId: string) {
      try {
        const nextSessions = await api.listSessions(workspaceId);
        if (!closed) setSessions(nextSessions);
      } catch (caught) {
        if (!closed) handleError(caught);
      }
    }

    return () => {
      closed = true;
      source?.close();
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      window.removeEventListener("online", recoverConnection);
      document.removeEventListener("visibilitychange", recoverConnection);
    };
  }, [auth, selectedId]);

  useEffect(() => {
    const wasRunning = previousRun.current !== null;
    previousRun.current = live.run;
    if (!selectedId || !wasRunning || live.run) return;
    void refreshHistory(selectedId, selectedSession);
  }, [live.run, selectedId, selectedSession]);

  useEffect(() => {
    const handlePopState = () => {
      const routed = readWorkspaceRoute(window.location.pathname);
      if (routed && workspaces.some((item) => item.id === routed)) setSelectedId(routed);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [workspaces]);

  async function refreshHistory(workspaceId: string, sessionId?: string) {
    try {
      const history = await api.loadHistory(workspaceId, sessionId);
      dispatch({ type: "frame", frame: { type: "session.snapshot", session: history } });
      setSessions(await api.listSessions(workspaceId));
    } catch (caught) {
      handleError(caught);
    }
  }

  function handleError(caught: unknown) {
    if (caught instanceof ApiError && caught.status === 401) {
      api.setSession(null);
      setAuth(null);
      setSelectedId(null);
      void api
        .loadProviders()
        .then(setProviders)
        .catch(() => setProviders([]));
    }
    setError(messageOf(caught));
  }

  function selectWorkspace(workspaceId: string) {
    setSelectedId(workspaceId);
    setMobileNav(false);
    window.history.pushState({}, "", workspaceRoute(workspaceId));
  }

  async function createWorkspace(name: string) {
    setBusy(true);
    try {
      const workspace = await api.createWorkspace(name);
      setWorkspaces((current) => [...current, workspace]);
      selectWorkspace(workspace.id);
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function renameWorkspace(workspaceId: string, name: string) {
    try {
      const workspace = await api.renameWorkspace(workspaceId, name);
      setWorkspaces((current) =>
        current.map((item) => (item.id === workspaceId ? workspace : item)),
      );
    } catch (caught) {
      handleError(caught);
    }
  }

  async function logout() {
    try {
      await api.logout();
    } catch (caught) {
      if (!(caught instanceof ApiError && caught.status === 401)) handleError(caught);
    }
    api.setSession(null);
    setAuth(null);
    setSelectedId(null);
    setProviders(await api.loadProviders().catch(() => []));
    window.history.replaceState({}, "", "/");
  }

  if (auth === undefined) return <LoadingScreen />;
  if (!auth) return <SignInScreen providers={providers} error={error} />;

  const selected = workspaces.find((workspace) => workspace.id === selectedId) ?? null;
  return (
    <div className="app-shell">
      <WorkspaceNav
        account={auth.account}
        workspaces={workspaces}
        selectedId={selectedId}
        open={mobileNav}
        busy={busy}
        onClose={() => setMobileNav(false)}
        onCreate={createWorkspace}
        onLogout={logout}
        onRename={renameWorkspace}
        onSelect={selectWorkspace}
      />
      <main className="workspace-main">
        <header className="topbar">
          <button
            className="icon-button menu-button"
            type="button"
            aria-label="Open workspaces"
            onClick={() => setMobileNav(true)}
          >
            ☰
          </button>
          <div className="topbar-title">
            <span className="eyebrow">Workspace</span>
            <strong>{selected?.name ?? "mikan"}</strong>
          </div>
          <ConnectionBadge status={live.connection} />
        </header>
        {error ? (
          <div className="notice notice-error" role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => setError(null)} aria-label="Dismiss error">
              ×
            </button>
          </div>
        ) : null}
        {selected ? (
          <Conversation
            workspace={selected}
            sessions={sessions}
            history={live.history}
            liveText={live.run?.responseText ?? ""}
            runStatus={live.run?.status ?? null}
            queue={live.queue}
            tools={Object.values(live.tools)}
            notices={live.notices}
            selectedSession={selectedSession}
            onSelectSession={(sessionId) => {
              setSelectedSession(sessionId);
              updateSessionUrl(selected.id, sessionId);
              void refreshHistory(selected.id, sessionId);
            }}
            onSubmit={async (text, mode, clientRequestId) => {
              try {
                await api.prompt(selected.id, { text, mode, clientRequestId });
              } catch (caught) {
                handleError(caught);
                throw caught;
              }
            }}
            onCancel={async () => {
              try {
                await api.cancel(selected.id);
              } catch (caught) {
                handleError(caught);
              }
            }}
          />
        ) : (
          <EmptyWorkspace onCreate={createWorkspace} />
        )}
      </main>
    </div>
  );
}

function SignInScreen(props: { providers: readonly WebIdentityProvider[]; error: string | null }) {
  return (
    <main className="signin-page">
      <section className="signin-card">
        <BrandMark />
        <p className="eyebrow">Your agent workspace</p>
        <h1>Build with a quieter kind of focus.</h1>
        <p className="signin-copy">
          Sign in to open your private mikan workspaces, durable sessions, and live agent runs.
        </p>
        {props.error ? (
          <div className="notice notice-error" role="alert">
            {props.error}
          </div>
        ) : null}
        <div className="provider-stack">
          {props.providers.map((provider) => (
            <a
              className="provider-button"
              href={`/auth/${provider}?returnTo=${encodeURIComponent(currentReturnPath())}`}
              key={provider}
            >
              <span className={`provider-icon provider-${provider}`} aria-hidden="true">
                {provider === "github" ? "GH" : "G"}
              </span>
              Continue with {provider === "github" ? "GitHub" : "Google"}
            </a>
          ))}
          {props.providers.length === 0 ? (
            <p className="empty-copy">No account provider is configured on this server.</p>
          ) : null}
        </div>
        <p className="signin-footnote">
          Account sign-in opens Web workspaces only. Adding credentials still requires a separate,
          short-lived vault link.
        </p>
      </section>
      <div className="signin-orbit" aria-hidden="true" />
    </main>
  );
}

function WorkspaceNav(props: {
  account: WebAccount;
  workspaces: readonly WebWorkspace[];
  selectedId: string | null;
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
  onLogout: () => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
  onSelect: (id: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  return (
    <>
      {props.open ? (
        <button
          className="nav-scrim"
          type="button"
          aria-label="Close workspaces"
          onClick={props.onClose}
        />
      ) : null}
      <aside className={`workspace-nav${props.open ? " is-open" : ""}`}>
        <div className="nav-brand">
          <BrandMark compact />
          <button
            className="icon-button nav-close"
            type="button"
            onClick={props.onClose}
            aria-label="Close workspaces"
          >
            ×
          </button>
        </div>
        <div className="nav-section-head">
          <span>Workspaces</span>
          <button
            className="icon-button"
            type="button"
            onClick={() => setCreating(true)}
            aria-label="Create workspace"
          >
            +
          </button>
        </div>
        {creating ? (
          <form
            className="create-workspace"
            onSubmit={(event) => {
              event.preventDefault();
              if (!name.trim()) return;
              void props.onCreate(name.trim()).then(() => {
                setName("");
                setCreating(false);
              });
            }}
          >
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Workspace name"
              maxLength={80}
            />
            <button type="submit" disabled={props.busy || !name.trim()}>
              Add
            </button>
          </form>
        ) : null}
        <nav className="workspace-list" aria-label="Workspaces">
          {props.workspaces.map((workspace) => (
            <WorkspaceRow
              key={workspace.id}
              workspace={workspace}
              active={workspace.id === props.selectedId}
              onRename={props.onRename}
              onSelect={props.onSelect}
            />
          ))}
        </nav>
        <div className="account-card">
          <Avatar account={props.account} />
          <div className="account-copy">
            <strong>{props.account.displayName}</strong>
            <span>Web account</span>
          </div>
          <button className="text-button" type="button" onClick={() => void props.onLogout()}>
            Log out
          </button>
        </div>
      </aside>
    </>
  );
}

function WorkspaceRow(props: {
  workspace: WebWorkspace;
  active: boolean;
  onRename: (id: string, name: string) => Promise<void>;
  onSelect: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(props.workspace.name);
  if (editing) {
    return (
      <form
        className="workspace-row editing"
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim()) return;
          void props.onRename(props.workspace.id, name.trim()).then(() => setEditing(false));
        }}
      >
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoFocus
          maxLength={80}
        />
        <button type="submit">Save</button>
      </form>
    );
  }
  return (
    <div className={`workspace-row${props.active ? " active" : ""}`}>
      <button
        className="workspace-select"
        type="button"
        onClick={() => props.onSelect(props.workspace.id)}
      >
        <span className="workspace-glyph">{props.workspace.name.slice(0, 1).toUpperCase()}</span>
        <span>{props.workspace.name}</span>
      </button>
      <button
        className="workspace-edit"
        type="button"
        onClick={() => setEditing(true)}
        aria-label={`Rename ${props.workspace.name}`}
      >
        ···
      </button>
    </div>
  );
}

function Conversation(props: {
  workspace: WebWorkspace;
  sessions: readonly WebSessionSummary[];
  history: WebSessionHistory | null;
  liveText: string;
  runStatus: "running" | "cancelling" | "failed" | null;
  queue: readonly { requestId: string; mode: "followUp" | "steer"; text: string }[];
  tools: readonly WebToolSnapshot[];
  notices: readonly { id: string; level: string; message: string }[];
  selectedSession?: string;
  onSelectSession: (sessionId?: string) => void;
  onSubmit: (
    text: string,
    mode: "prompt" | "followUp" | "steer",
    clientRequestId: string,
  ) => Promise<void>;
  onCancel: () => Promise<void>;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [props.history?.entryCount, props.liveText, props.queue.length]);
  return (
    <div className="conversation-layout">
      <div className="conversation-head">
        <div>
          <p className="eyebrow">Conversation</p>
          <h1>{props.history?.title ?? props.workspace.name}</h1>
        </div>
        <label className="session-picker">
          <span className="sr-only">Session</span>
          <select
            value={props.selectedSession ?? ""}
            onChange={(event) => props.onSelectSession(event.target.value || undefined)}
          >
            <option value="">Current session</option>
            {props.sessions
              .filter((session) => !session.current)
              .map((session) => (
                <option value={session.id} key={session.id}>
                  {session.title}
                </option>
              ))}
          </select>
        </label>
      </div>
      <div className="conversation-scroll" aria-live="polite">
        <div className="conversation-feed">
          {props.history?.items.length ? (
            props.history.items.map((item, index) => (
              <HistoryItem item={item} key={item.entryId ?? `${item.kind}:${index}`} />
            ))
          ) : (
            <Welcome workspace={props.workspace} />
          )}
          {props.liveText ? (
            <article className="message-row assistant-message live-message">
              <AssistantMark />
              <div className="message-content markdown-content">
                <SafeMarkdown>{props.liveText}</SafeMarkdown>
                {props.runStatus === "running" ? (
                  <span className="stream-caret" aria-label="Streaming" />
                ) : null}
              </div>
            </article>
          ) : null}
          {props.tools.map((tool) => (
            <ToolCard key={tool.id} tool={tool} />
          ))}
          {props.notices.map((notice) => (
            <div className={`inline-notice notice-${notice.level}`} key={notice.id}>
              {notice.message}
            </div>
          ))}
          <div ref={endRef} />
        </div>
      </div>
      <Composer
        runStatus={props.runStatus}
        queue={props.queue}
        onSubmit={props.onSubmit}
        onCancel={props.onCancel}
      />
    </div>
  );
}

function HistoryItem({ item }: { item: WebSessionHistory["items"][number] }) {
  if (item.kind === "tool") {
    return (
      <div className={`durable-tool tone-${item.tone ?? "default"}`}>
        <span>{item.title}</span>
        {item.body ? <pre>{item.body}</pre> : null}
      </div>
    );
  }
  if (item.kind === "system") {
    return <div className="system-line">{[item.title, item.body].filter(Boolean).join(" — ")}</div>;
  }
  const assistant = item.kind === "assistant";
  return (
    <article className={`message-row ${assistant ? "assistant-message" : "user-message"}`}>
      {assistant ? <AssistantMark /> : null}
      <div className="message-content">
        {item.title ? <span className="message-label">{item.title}</span> : null}
        <div className="markdown-content">
          <SafeMarkdown>{item.body ?? ""}</SafeMarkdown>
        </div>
        {item.meta ? <time>{formatTime(item.meta)}</time> : null}
      </div>
    </article>
  );
}

export function SafeMarkdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children: linkChildren }) => (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {linkChildren}
          </a>
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  );
}

function ToolCard({ tool }: { tool: WebToolSnapshot }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <section className={`tool-card tool-${tool.status}`}>
      <button type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
        <span className="tool-status-dot" />
        <strong>{tool.label ?? tool.name}</strong>
        <span>
          {tool.status === "running" ? "Running" : tool.status === "error" ? "Failed" : "Done"}
        </span>
      </button>
      {expanded && tool.result ? <pre>{tool.result}</pre> : null}
    </section>
  );
}

export function Composer(props: {
  runStatus: "running" | "cancelling" | "failed" | null;
  queue: readonly { requestId: string; mode: "followUp" | "steer"; text: string }[];
  onSubmit: (
    text: string,
    mode: "prompt" | "followUp" | "steer",
    clientRequestId: string,
  ) => Promise<void>;
  onCancel: () => Promise<void>;
}) {
  const running = props.runStatus === "running" || props.runStatus === "cancelling";
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"followUp" | "steer">("followUp");
  const [sending, setSending] = useState(false);
  const [pendingSubmission, setPendingSubmission] = useState<{
    readonly text: string;
    readonly mode: "prompt" | "followUp" | "steer";
    readonly clientRequestId: string;
  } | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);

  async function sendSubmission(submission: NonNullable<typeof pendingSubmission>) {
    setSending(true);
    try {
      await props.onSubmit(submission.text, submission.mode, submission.clientRequestId);
      setPendingSubmission(null);
      setText("");
      if (textarea.current) textarea.current.style.height = "auto";
    } catch {
      setPendingSubmission(submission);
    } finally {
      setSending(false);
    }
  }

  async function submit() {
    const value = text.trim();
    if (!value || sending || props.runStatus === "cancelling") return;
    const selectedMode: "prompt" | "followUp" | "steer" = running ? mode : "prompt";
    const submission =
      pendingSubmission?.text === value && pendingSubmission.mode === selectedMode
        ? pendingSubmission
        : { text: value, mode: selectedMode, clientRequestId: crypto.randomUUID() };
    await sendSubmission(submission);
  }

  return (
    <div className="composer-zone">
      {props.queue.length ? (
        <div className="queue-strip">
          {props.queue.map((item) => (
            <span key={item.requestId}>
              <strong>{item.mode === "steer" ? "Steering" : "Next"}</strong> {item.text}
            </span>
          ))}
        </div>
      ) : null}
      {pendingSubmission ? (
        <div className="retry-strip" role="status">
          <span>Message was not admitted.</span>
          <button
            type="button"
            disabled={sending}
            onClick={() => void sendSubmission(pendingSubmission)}
          >
            Retry
          </button>
        </div>
      ) : null}
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <textarea
          ref={textarea}
          value={text}
          rows={1}
          aria-label="Message mikan"
          placeholder={running ? "Add a follow-up or steer this run…" : "Ask mikan anything…"}
          onChange={(event) => {
            setText(event.target.value);
            setPendingSubmission(null);
            event.target.style.height = "auto";
            event.target.style.height = `${Math.min(event.target.scrollHeight, 180)}px`;
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <div className="composer-footer">
          <div className="composer-modes">
            {running ? (
              <select
                value={mode}
                onChange={(event) => setMode(event.target.value as "followUp" | "steer")}
                aria-label="Message mode"
              >
                <option value="followUp">Follow up</option>
                <option value="steer">Steer current run</option>
              </select>
            ) : (
              <span className="composer-hint">Enter to send · Shift+Enter for a new line</span>
            )}
          </div>
          <div className="composer-actions">
            {running ? (
              <button
                className="cancel-button"
                type="button"
                onClick={() => void props.onCancel()}
                disabled={props.runStatus === "cancelling"}
              >
                {props.runStatus === "cancelling" ? "Stopping…" : "Stop"}
              </button>
            ) : null}
            <button
              className="send-button"
              type="submit"
              disabled={!text.trim() || sending || props.runStatus === "cancelling"}
              aria-label="Send message"
            >
              ↑
            </button>
          </div>
        </div>
      </form>
      <p className="composer-disclaimer">
        mikan can make mistakes. Review code and tool output before using it.
      </p>
    </div>
  );
}

function Welcome({ workspace }: { workspace: WebWorkspace }) {
  return (
    <section className="welcome-state">
      <span className="welcome-sun" aria-hidden="true" />
      <p className="eyebrow">{workspace.name}</p>
      <h2>What should we make?</h2>
      <p>This workspace keeps its own sessions, memory, files, credentials, and sandbox context.</p>
    </section>
  );
}

function EmptyWorkspace({ onCreate }: { onCreate: (name: string) => Promise<void> }) {
  return (
    <section className="empty-workspace">
      <BrandMark />
      <h1>Create your first workspace</h1>
      <p>A workspace is an independent office for sessions, memory, tools, and files.</p>
      <button type="button" onClick={() => void onCreate("Personal")}>
        Create Personal
      </button>
    </section>
  );
}

function LoadingScreen() {
  return (
    <main className="loading-screen">
      <BrandMark />
      <span>Opening your workspace…</span>
    </main>
  );
}

function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand-mark${compact ? " compact" : ""}`}>
      <span className="brand-fruit">み</span>
      {compact ? null : <strong>mikan</strong>}
    </div>
  );
}

function AssistantMark() {
  return (
    <span className="assistant-mark" aria-label="mikan">
      み
    </span>
  );
}

function Avatar({ account }: { account: WebAccount }) {
  return account.avatarUrl ? (
    <img className="avatar" src={account.avatarUrl} alt="" />
  ) : (
    <span className="avatar avatar-fallback">{account.displayName.slice(0, 1).toUpperCase()}</span>
  );
}

function ConnectionBadge({ status }: { status: "connecting" | "open" | "closed" }) {
  return (
    <span className={`connection-badge connection-${status}`}>
      <span />
      {status === "open" ? "Live" : status === "connecting" ? "Connecting" : "Reconnecting"}
    </span>
  );
}

function currentReturnPath(): string {
  return `${window.location.pathname}${window.location.hash}`;
}

function updateSessionUrl(workspaceId: string, sessionId?: string): void {
  const url = new URL(workspaceRoute(workspaceId), window.location.origin);
  if (sessionId) url.searchParams.set("session", sessionId);
  window.history.replaceState({}, "", `${url.pathname}${url.search}`);
}

function replaceWorkspaceUrl(workspaceId: string) {
  window.history.replaceState({}, "", workspaceRoute(workspaceId));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
