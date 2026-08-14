import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost, queryParam } from "@geminixiang/mikan-web-client";
import "./admin.css";

// ── Wire types (mirror of the daemon's /admin/api/* responses) ──────────────

interface AdminConversationRow {
  platform: string;
  conversationId: string;
  label: string;
  running: boolean;
  lastActivityAt: string | null;
}

interface ConversationState {
  conversationId: string;
  provider: string | null;
  model: string | null;
  thinkingLevel: string | null;
  globalProvider: string | null;
  globalModel: string | null;
  workspaceDoorPolicy: string;
  workspaceLayout: string;
  workspaceOverride: string | null;
  globalWorkspaceDoorPolicy: string;
  autoReplyEnabled: boolean;
  autoReplyRules: Array<{ match: string; reply: string }>;
  slack: { replyMode: string; globalReplyMode: string };
}

interface ModelRow {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  input: number | null;
  contextWindow: number | null;
  maxTokens: number | null;
  status: "available" | "unverified";
}

interface UsageRow {
  conversationId: string;
  label: string;
  fileName: string;
  sessionId: string;
  updatedAt: string;
  input: number;
  output: number;
  total: number;
  cost: number;
}

interface EventRow {
  name: string;
  size: number;
  mtimeMs: number;
  type: string | null;
  conversationId: string | null;
  text: string | null;
  at: string | null;
  schedule: string | null;
  timezone: string | null;
}

interface GlobalSettings {
  provider: string | null;
  model: string | null;
  thinkingLevel: string | null;
  sandboxCpus: number | null;
  sandboxMemory: number | null;
  workspaceDoorPolicy: string;
  workspaceLayout: string;
  defaultSharedVault: string | null;
  slack: { replyMode: string };
}

interface Me {
  platform: string;
  platformUserId: string;
  label: string;
  expiresAt: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function adminUrl(path: string, token: string): string {
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}token=${encodeURIComponent(token)}`;
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function fmtTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString();
}

// ── Tabs ────────────────────────────────────────────────────────────────────

type Tab = "conversations" | "models" | "usage" | "events" | "settings";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "conversations", label: "Conversations" },
  { id: "models", label: "Models" },
  { id: "usage", label: "Usage" },
  { id: "events", label: "Events" },
  { id: "settings", label: "Settings" },
];

// ── Conversations tab ───────────────────────────────────────────────────────

function ConversationsTab({ token }: { token: string }) {
  const [rows, setRows] = useState<AdminConversationRow[] | null>(null);
  const [selected, setSelected] = useState<AdminConversationRow | null>(null);
  const [state, setState] = useState<ConversationState | null>(null);
  const [models, setModels] = useState<ModelRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await apiGet<{ conversations: AdminConversationRow[] }>(
        adminUrl("/admin/api/conversations", token),
      );
      setRows(data.conversations);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = async (row: AdminConversationRow): Promise<void> => {
    setSelected(row);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (row.platform) params.set("platform", row.platform);
      params.set("conversationId", row.conversationId);
      const [stateData, modelsData] = await Promise.all([
        apiGet<ConversationState>(
          `${adminUrl("/admin/api/conversation-state", token)}&${params.toString()}`,
        ),
        apiGet<{ models: ModelRow[] }>(adminUrl("/admin/api/models", token)),
      ]);
      setState(stateData);
      setModels(modelsData.models);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const switchModel = async (
    provider: string,
    model: string,
    thinkingLevel: string,
  ): Promise<void> => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost("/admin/api/conversations/model", {
        token,
        platform: selected.platform,
        conversationId: selected.conversationId,
        provider,
        model,
        thinkingLevel,
      });
      await open(selected);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (error) return <div className="err-msg">{error}</div>;
  if (!rows) return <div className="loading-msg">Loading conversations…</div>;

  return (
    <div className="admin-split">
      <ConversationList rows={rows} selected={selected} onOpen={(row) => void open(row)} />
      <ConversationDetail
        selected={selected}
        state={state}
        models={models}
        busy={busy}
        onSwitch={(p, m) => void switchModel(p, m, state?.thinkingLevel ?? "none")}
      />
    </div>
  );
}

function ConversationList({
  rows,
  selected,
  onOpen,
}: {
  rows: AdminConversationRow[];
  selected: AdminConversationRow | null;
  onOpen: (row: AdminConversationRow) => void;
}) {
  return (
    <div className="card conv-list">
      <p className="eyebrow">Conversations</p>
      {rows.length === 0 ? (
        <div className="empty-state">No conversations registered yet.</div>
      ) : (
        <ul className="conv-ul">
          {rows.map((row) => (
            <li key={`${row.platform}:${row.conversationId}`}>
              <button
                className={`conv-row${selected?.conversationId === row.conversationId ? " active" : ""}`}
                onClick={() => onOpen(row)}
              >
                <span className="conv-label">{row.label}</span>
                <span className="conv-meta">
                  {row.running ? (
                    <span className="badge running">running</span>
                  ) : (
                    <span className="badge">idle</span>
                  )}
                  <span>{row.platform}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ConversationDetail({
  selected,
  state,
  models,
  busy,
  onSwitch,
}: {
  selected: AdminConversationRow | null;
  state: ConversationState | null;
  models: ModelRow[] | null;
  busy: boolean;
  onSwitch: (provider: string, model: string) => void;
}) {
  if (!selected || !state) {
    return (
      <div className="card conv-detail">
        <div className="empty-state">Select a conversation to inspect it.</div>
      </div>
    );
  }
  return (
    <div className="card conv-detail">
      <p className="eyebrow">Conversation</p>
      <h3 className="conv-title">{state.conversationId}</h3>
      <dl className="kv">
        <dt>Model</dt>
        <dd>
          {state.provider} / {state.model}{" "}
          {state.thinkingLevel ? `(thinking ${state.thinkingLevel})` : ""}
          <span className="kv-hint">
            global: {state.globalProvider} / {state.globalModel}
          </span>
        </dd>
        <dt>Door policy</dt>
        <dd>
          {state.workspaceDoorPolicy} / {state.workspaceLayout}
          {state.workspaceOverride ? ` (override: ${state.workspaceOverride})` : ""}
          <span className="kv-hint">global: {state.globalWorkspaceDoorPolicy}</span>
        </dd>
        <dt>Auto-reply</dt>
        <dd>
          {state.autoReplyEnabled ? `enabled (${state.autoReplyRules.length} rules)` : "disabled"}
        </dd>
        <dt>Slack reply mode</dt>
        <dd>
          {state.slack.replyMode} (global: {state.slack.globalReplyMode})
        </dd>
      </dl>
      <p className="eyebrow">Switch model</p>
      <ModelPicker
        models={models ?? []}
        currentProvider={state.provider}
        currentModel={state.model}
        busy={busy}
        onSwitch={onSwitch}
      />
    </div>
  );
}

function ModelPicker({
  models,
  currentProvider,
  currentModel,
  busy,
  onSwitch,
}: {
  models: ModelRow[];
  currentProvider: string | null;
  currentModel: string | null;
  busy: boolean;
  onSwitch: (provider: string, model: string) => void;
}) {
  const [provider, setProvider] = useState(currentProvider ?? models[0]?.provider ?? "");
  const [model, setModel] = useState(currentModel ?? "");
  useEffect(() => {
    setProvider(currentProvider ?? models[0]?.provider ?? "");
    setModel(currentModel ?? "");
  }, [currentProvider, currentModel, models]);
  const providerModels = models.filter((m) => m.provider === provider);
  return (
    <div className="model-picker">
      <select value={provider} onChange={(e) => setProvider(e.target.value)}>
        {[...new Set(models.map((m) => m.provider))].map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
      <select value={model} onChange={(e) => setModel(e.target.value)}>
        {providerModels.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name} {m.status === "unverified" ? "(unverified)" : ""}
          </option>
        ))}
      </select>
      <button
        className="primary-action-btn"
        disabled={busy || !provider || !model}
        onClick={() => onSwitch(provider, model)}
      >
        {busy ? "Switching…" : "Switch"}
      </button>
    </div>
  );
}

// ── Models tab ──────────────────────────────────────────────────────────────

function ModelsTab({ token }: { token: string }) {
  const [models, setModels] = useState<ModelRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    apiGet<{ models: ModelRow[] }>(adminUrl("/admin/api/models", token))
      .then((data) => setModels(data.models))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [token]);
  if (error) return <div className="err-msg">{error}</div>;
  if (!models) return <div className="loading-msg">Loading models…</div>;
  return (
    <div className="card">
      <p className="eyebrow">Models</p>
      <table className="data-table">
        <thead>
          <tr>
            <th>Provider</th>
            <th>Model</th>
            <th>Reasoning</th>
            <th>Input $/M</th>
            <th>Context</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {models.map((m) => (
            <tr key={`${m.provider}/${m.id}`}>
              <td>{m.provider}</td>
              <td>
                {m.name}
                <span className="mono"> ({m.id})</span>
              </td>
              <td>{m.reasoning ? "yes" : "no"}</td>
              <td>{m.input === null ? "—" : m.input.toFixed(2)}</td>
              <td>{fmtTokens(m.contextWindow)}</td>
              <td>
                <span className={`badge ${m.status === "available" ? "ok" : "warn"}`}>
                  {m.status}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Usage tab ───────────────────────────────────────────────────────────────

function UsageTab({ token }: { token: string }) {
  const [rows, setRows] = useState<UsageRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    apiGet<{ sessions: UsageRow[] }>(adminUrl("/admin/api/session-usage", token))
      .then((data) => setRows(data.sessions))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [token]);
  if (error) return <div className="err-msg">{error}</div>;
  if (!rows) return <div className="loading-msg">Loading usage…</div>;
  return (
    <div className="card">
      <p className="eyebrow">Session usage (top 20 by tokens)</p>
      <table className="data-table">
        <thead>
          <tr>
            <th>Conversation</th>
            <th>Session</th>
            <th>Updated</th>
            <th>Input</th>
            <th>Output</th>
            <th>Total</th>
            <th>Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.sessionId}>
              <td>{r.label}</td>
              <td>
                <span className="mono">{r.fileName}</span>
              </td>
              <td>{fmtDate(r.updatedAt)}</td>
              <td>{fmtTokens(r.input)}</td>
              <td>{fmtTokens(r.output)}</td>
              <td>{fmtTokens(r.total)}</td>
              <td>${r.cost.toFixed(4)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Events tab ──────────────────────────────────────────────────────────────

function EventsTab({ token }: { token: string }) {
  const [events, setEvents] = useState<EventRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    apiGet<{ events: EventRow[] }>(adminUrl("/admin/api/events", token))
      .then((data) => setEvents(data.events))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [token]);
  if (error) return <div className="err-msg">{error}</div>;
  if (!events) return <div className="loading-msg">Loading events…</div>;
  return (
    <div className="card">
      <p className="eyebrow">Scheduled events</p>
      {events.length === 0 ? (
        <div className="empty-state">No event files yet.</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>File</th>
              <th>Type</th>
              <th>Conversation</th>
              <th>Schedule / at</th>
              <th>Size</th>
              <th>Modified</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.name}>
                <td>
                  <span className="mono">{e.name}</span>
                </td>
                <td>{e.type ?? "—"}</td>
                <td>{e.conversationId ?? "—"}</td>
                <td>{e.schedule ?? e.at ?? "—"}</td>
                <td>{fmtBytes(e.size)}</td>
                <td>{fmtDate(new Date(e.mtimeMs).toISOString())}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Settings tab ────────────────────────────────────────────────────────────

function SettingsTab({ token }: { token: string }) {
  const [settings, setSettings] = useState<GlobalSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(() => {
    apiGet<GlobalSettings>(adminUrl("/admin/api/settings/global", token))
      .then(setSettings)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  const save = async (patch: Record<string, unknown>): Promise<void> => {
    try {
      await apiPost("/admin/api/settings/model", { token, ...patch });
      setSaved("Saved ✓");
      setError(null);
      setTimeout(() => setSaved(null), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (error) return <div className="err-msg">{error}</div>;
  if (!settings) return <div className="loading-msg">Loading settings…</div>;

  return (
    <div className="card settings-card">
      <p className="eyebrow">Global settings</p>
      <dl className="kv">
        <dt>Default model</dt>
        <dd>
          {settings.provider} / {settings.model}{" "}
          {settings.thinkingLevel ? `(thinking ${settings.thinkingLevel})` : ""}
        </dd>
        <dt>Sandbox</dt>
        <dd>
          {settings.sandboxCpus ?? "?"} cpus · {settings.sandboxMemory ?? "?"} MB
        </dd>
        <dt>Workspace door</dt>
        <dd>
          {settings.workspaceDoorPolicy} / {settings.workspaceLayout}
          {settings.defaultSharedVault ? ` · vault ${settings.defaultSharedVault}` : ""}
        </dd>
        <dt>Slack reply mode</dt>
        <dd>{settings.slack.replyMode}</dd>
      </dl>
      <p className="eyebrow">Change default model</p>
      <div className="model-picker">
        <select
          defaultValue={settings.provider ?? ""}
          onChange={(e) => void save({ provider: e.target.value })}
        >
          <option value={settings.provider ?? ""}>{settings.provider ?? "current"}</option>
          <option value="openai">openai</option>
          <option value="anthropic">anthropic</option>
        </select>
        {saved ? <span className="save-note">{saved}</span> : null}
      </div>
      <div className="kv-hint">
        Use the Models tab to pick exact ids; this tab exposes the read surface.
      </div>
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

export function AdminPage() {
  const token = queryParam("token") ?? "";
  const [tab, setTab] = useState<Tab>("conversations");
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    if (!token) return;
    apiGet<Me>(adminUrl("/admin/api/me", token))
      .then(setMe)
      .catch(() => setMe(null));
  }, [token]);

  if (!token) {
    return (
      <div className="card">
        <p className="eyebrow">Admin</p>
        <h2 className="card-title">Admin link required</h2>
        <div className="err-msg">
          This link is missing, invalid, or expired. Send <code>/admin</code> to the bot to get a
          fresh link.
        </div>
      </div>
    );
  }

  return (
    <>
      <header className="page-head">
        <div>
          <p className="eyebrow">Admin</p>
          <h2 className="page-title">mikan admin</h2>
          <p className="page-desc">
            {me
              ? `${me.label} · expires ${fmtDate(new Date(me.expiresAt).toISOString())}`
              : "Authenticated by link token."}
          </p>
        </div>
      </header>
      <div className="tab-row" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`tab-btn${tab === t.id ? " active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "conversations" ? <ConversationsTab token={token} /> : null}
      {tab === "models" ? <ModelsTab token={token} /> : null}
      {tab === "usage" ? <UsageTab token={token} /> : null}
      {tab === "events" ? <EventsTab token={token} /> : null}
      {tab === "settings" ? <SettingsTab token={token} /> : null}
    </>
  );
}
