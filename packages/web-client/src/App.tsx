import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  createBrowserRouter,
  Navigate,
  RouterProvider,
  useNavigate,
  useParams,
} from "react-router-dom";
import type {
  HarnessConversationSnapshot,
  HarnessModelOption,
  HarnessThinkingLevel,
  HarnessTranscriptItem,
} from "@geminixiang/mikan-harness-web-contract";
import type { HarnessClient } from "./client.js";
import { beginGitHubLogin } from "./transport.js";
import "./app.css";

const THINKING_LEVELS: HarnessThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export function App({ client }: { client: HarnessClient }) {
  const router = useMemo(
    () =>
      createBrowserRouter([
        { path: "/login", element: <LoginPage /> },
        { path: "/", element: <HarnessPage client={client} /> },
        { path: "/conversations/:officeKey", element: <HarnessPage client={client} /> },
        { path: "*", element: <Navigate to="/" replace /> },
      ]),
    [client],
  );
  useEffect(() => () => client.dispose(), [client]);
  return <RouterProvider router={router} />;
}

function HarnessPage({ client }: { client: HarnessClient }) {
  const { officeKey } = useParams();
  const navigate = useNavigate();
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot);

  useEffect(() => {
    void client.open(officeKey);
  }, [client, officeKey]);

  useEffect(() => {
    const first = state.conversations[0];
    if (state.status === "ready" && !officeKey && first) {
      navigate(`/conversations/${encodeURIComponent(first.officeKey)}`, { replace: true });
    }
  }, [navigate, officeKey, state.conversations, state.status]);

  if (state.status === "unauthenticated") return <Navigate to="/login" replace />;
  if (state.status === "loading") return <CenteredStatus text="Loading mikan…" />;

  const createConversation = async (): Promise<void> => {
    try {
      const key = await client.createConversation();
      navigate(`/conversations/${encodeURIComponent(key)}`);
    } catch {
      // The client exposes the actionable error in its snapshot.
    }
  };

  return (
    <div className="harness-layout">
      <ConversationSidebar
        conversations={state.conversations}
        activeOfficeKey={officeKey}
        onCreate={() => void createConversation()}
      />
      <main className="harness-main">
        <Topbar
          identity={state.principal?.displayName ?? ""}
          connection={state.connection}
          onLogout={() => void client.logout().catch(() => {})}
        />
        {state.error && <div className="error-banner">{state.error}</div>}
        {state.conversation ? (
          <ConversationView
            conversation={state.conversation}
            models={state.models}
            client={client}
          />
        ) : (
          <EmptyConversation onCreate={() => void createConversation()} />
        )}
      </main>
    </div>
  );
}

function ConversationSidebar({
  conversations,
  activeOfficeKey,
  onCreate,
}: {
  conversations: ReturnType<HarnessClient["getSnapshot"]>["conversations"];
  activeOfficeKey?: string;
  onCreate: () => void;
}) {
  const navigate = useNavigate();
  return (
    <aside className="conversation-sidebar">
      <div className="sidebar-brand">
        <span className="brand-mark">m</span>
        <span>mikan</span>
      </div>
      <button className="new-conversation" onClick={onCreate}>
        <span aria-hidden="true">＋</span> New conversation
      </button>
      <nav className="conversation-list" aria-label="Conversations">
        {conversations.map((conversation) => (
          <button
            key={conversation.officeKey}
            className={`conversation-link${
              conversation.officeKey === activeOfficeKey ? " active" : ""
            }`}
            onClick={() => navigate(`/conversations/${encodeURIComponent(conversation.officeKey)}`)}
          >
            <span>{conversation.title}</span>
            <small>{conversation.run ? "Running" : relativeTime(conversation.updatedAt)}</small>
          </button>
        ))}
      </nav>
    </aside>
  );
}

function Topbar({
  identity,
  connection,
  onLogout,
}: {
  identity: string;
  connection: string;
  onLogout: () => void;
}) {
  return (
    <header className="harness-topbar">
      <span className={`connection-dot ${connection}`} aria-hidden="true" />
      <span className="connection-label">{connection}</span>
      <div className="topbar-spacer" />
      <span className="identity">{identity}</span>
      <button className="text-button" onClick={onLogout}>
        Sign out
      </button>
    </header>
  );
}

function ConversationView({
  conversation,
  models,
  client,
}: {
  conversation: HarnessConversationSnapshot;
  models: HarnessModelOption[];
  client: HarnessClient;
}) {
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [conversation.transcript]);

  const send = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || conversation.run) return;
    setDraft("");
    try {
      await client.prompt(text);
    } catch {
      setDraft(text);
    }
  };

  return (
    <section className="conversation-view">
      <ConversationHeader conversation={conversation} models={models} client={client} />
      <div className="transcript" aria-live="polite">
        {conversation.transcript.length === 0 ? (
          <div className="transcript-empty">What would you like to work on?</div>
        ) : (
          conversation.transcript.map((item) => <TranscriptItem key={item.id} item={item} />)
        )}
        <div ref={endRef} />
      </div>
      <Composer
        draft={draft}
        running={Boolean(conversation.run)}
        stopping={conversation.run?.status === "stopping"}
        onDraft={setDraft}
        onSend={() => void send()}
        onCancel={() => void client.cancel().catch(() => {})}
      />
    </section>
  );
}

function ConversationHeader({
  conversation,
  models,
  client,
}: {
  conversation: HarnessConversationSnapshot;
  models: HarnessModelOption[];
  client: HarnessClient;
}) {
  const modelValue = JSON.stringify([conversation.model.provider, conversation.model.model]);
  const changeModel = (value: string): void => {
    const selected = JSON.parse(value) as [string, string];
    void client
      .setModel(selected[0], selected[1], conversation.model.thinkingLevel)
      .catch(() => {});
  };
  const changeThinking = (thinkingLevel: HarnessThinkingLevel): void => {
    void client
      .setModel(conversation.model.provider, conversation.model.model, thinkingLevel)
      .catch(() => {});
  };
  return (
    <header className="conversation-header">
      <div>
        <h1>{conversation.title}</h1>
        <span className="session-label">Session {conversation.sessionId.slice(0, 8)}</span>
      </div>
      <div className="model-controls">
        <label>
          <span>Model</span>
          <select
            value={modelValue}
            disabled={Boolean(conversation.run)}
            onChange={(event) => changeModel(event.target.value)}
          >
            {models.map((model) => (
              <option
                key={`${model.provider}/${model.id}`}
                value={JSON.stringify([model.provider, model.id])}
              >
                {model.name} · {model.provider}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Thinking</span>
          <select
            value={conversation.model.thinkingLevel}
            disabled={Boolean(conversation.run)}
            onChange={(event) => changeThinking(event.target.value as HarnessThinkingLevel)}
          >
            {THINKING_LEVELS.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </label>
      </div>
    </header>
  );
}

function TranscriptItem({ item }: { item: HarnessTranscriptItem }) {
  return (
    <article className={`transcript-item ${item.role} ${item.tone ?? "default"}`}>
      <div className="transcript-meta">
        <strong>{item.title}</strong>
        <time dateTime={item.timestamp}>{formatTime(item.timestamp)}</time>
      </div>
      <div className="transcript-text">{item.text}</div>
    </article>
  );
}

function Composer({
  draft,
  running,
  stopping,
  onDraft,
  onSend,
  onCancel,
}: {
  draft: string;
  running: boolean;
  stopping: boolean;
  onDraft: (value: string) => void;
  onSend: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="composer">
      <textarea
        value={draft}
        disabled={running}
        placeholder={running ? "mikan is working…" : "Message mikan"}
        rows={3}
        onChange={(event) => onDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            onSend();
          }
        }}
      />
      {running ? (
        <button className="cancel-button" disabled={stopping} onClick={onCancel}>
          {stopping ? "Stopping…" : "Stop"}
        </button>
      ) : (
        <button className="send-button" disabled={!draft.trim()} onClick={onSend}>
          Send
        </button>
      )}
    </div>
  );
}

function EmptyConversation({ onCreate }: { onCreate: () => void }) {
  return (
    <section className="empty-conversation">
      <div className="empty-mark">m</div>
      <h1>Start a conversation</h1>
      <p>Each conversation gets its own persistent office, context, and sandbox.</p>
      <button className="primary-button" onClick={onCreate}>
        New conversation
      </button>
    </section>
  );
}

function LoginPage() {
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const login = async (): Promise<void> => {
    setLoading(true);
    setError("");
    try {
      await beginGitHubLogin();
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : String(loginError));
      setLoading(false);
    }
  };
  return (
    <main className="login-page">
      <div className="login-card">
        <div className="empty-mark">m</div>
        <h1>Sign in to mikan</h1>
        <p>Use the GitHub account linked from your private chat.</p>
        <button className="github-button" disabled={loading} onClick={() => void login()}>
          {loading ? "Redirecting…" : "Continue with GitHub"}
        </button>
        {error && <div className="error-banner">{error}</div>}
      </div>
    </main>
  );
}

function CenteredStatus({ text }: { text: string }) {
  return <main className="centered-status">{text}</main>;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "";
}

function relativeTime(value: string): string {
  const delta = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(delta) || delta < 60_000) return "now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  return `${Math.floor(delta / 86_400_000)}d`;
}
