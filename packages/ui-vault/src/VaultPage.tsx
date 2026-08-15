import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost, useQueryParam } from "@geminixiang/mikan-web-client";
import "./vault.css";

interface LinkInfo {
  valid: boolean;
  expiresAt?: number;
  vaultId?: string;
  providerIdHint?: string | null;
  oauthServices?: Array<{ id: string; label: string }>;
  existingSecrets?: { envKeys: string[]; mountTargets: string[] };
}

interface CompleteResponse {
  message?: string;
  error?: string;
}

interface OAuthStartResponse {
  redirectUrl?: string;
  error?: string;
}

function parseEnv(text: string): { env: Record<string, string>; error?: string } {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) return { env, error: `Invalid line (expected KEY=VALUE): ${line}` };
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return { env };
}

function SecretsSummary({ secrets }: { secrets: NonNullable<LinkInfo["existingSecrets"]> }) {
  if (secrets.envKeys.length === 0 && secrets.mountTargets.length === 0) return null;
  return (
    <div className="card">
      <p className="eyebrow">Currently stored</p>
      <dl className="kv">
        {secrets.envKeys.length > 0 ? (
          <>
            <dt>Env keys</dt>
            <dd className="chips">
              {secrets.envKeys.map((k) => (
                <code key={k}>{k}</code>
              ))}
            </dd>
          </>
        ) : null}
        {secrets.mountTargets.length > 0 ? (
          <>
            <dt>Mounts</dt>
            <dd>{secrets.mountTargets.join(", ")}</dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}

function ApiKeyForm({ token, onStatus }: { token: string; onStatus: (message: string) => void }) {
  const [envText, setEnvText] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    const parsed = parseEnv(envText);
    if (parsed.error) {
      onStatus(parsed.error);
      return;
    }
    if (Object.keys(parsed.env).length === 0) {
      onStatus("Enter at least one KEY=VALUE pair before continuing.");
      return;
    }
    setBusy(true);
    try {
      const data = await apiPost<CompleteResponse>("/api/link/complete", {
        token,
        mode: "api_key",
        env: parsed.env,
      });
      onStatus(data.message ?? "Credential stored. You can close this tab.");
    } catch (err) {
      onStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void save(e)}>
      <label className="field-label" htmlFor="envText">
        Environment variables (one KEY=VALUE per line)
      </label>
      <textarea
        id="envText"
        rows={6}
        value={envText}
        onChange={(e) => setEnvText(e.target.value)}
        placeholder={"OPENAI_API_KEY=sk-...\nANTHROPIC_API_KEY=sk-..."}
        spellCheck={false}
      />
      <div className="form-actions">
        <button className="primary-action-btn" type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save to vault"}
        </button>
      </div>
    </form>
  );
}

function OAuthForm({
  services,
  token,
  onStatus,
}: {
  services: NonNullable<LinkInfo["oauthServices"]>;
  token: string;
  onStatus: (message: string) => void;
}) {
  const [serviceId, setServiceId] = useState(services[0]?.id ?? "");
  const [busy, setBusy] = useState(false);

  const save = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const data = await apiPost<OAuthStartResponse>("/api/oauth/start", { token, serviceId });
      if (data.redirectUrl) {
        window.location.href = data.redirectUrl;
        return;
      }
      onStatus(data.error ?? "OAuth could not start.");
    } catch (err) {
      onStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void save(e)}>
      <label className="field-label" htmlFor="oauthService">
        OAuth service
      </label>
      <select
        className="field-like"
        id="oauthService"
        value={serviceId}
        onChange={(e) => setServiceId(e.target.value)}
      >
        {services.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </select>
      <div className="form-actions">
        <button className="primary-action-btn" type="submit" disabled={busy}>
          {busy ? "Redirecting…" : "Authorize"}
        </button>
      </div>
    </form>
  );
}

function CredentialForm({
  oauthServices,
  providerIdHint,
  token,
  onStatus,
}: {
  oauthServices: NonNullable<LinkInfo["oauthServices"]>;
  providerIdHint: string | null;
  token: string;
  onStatus: (message: string) => void;
}) {
  const [mode, setMode] = useState<"api_key" | "oauth">(providerIdHint ? "oauth" : "api_key");

  return (
    <div className="card">
      <p className="eyebrow">Add credential</p>
      {oauthServices.length > 0 ? (
        <div className="mode-row">
          <label>
            <input
              type="radio"
              name="mode"
              checked={mode === "oauth"}
              onChange={() => setMode("oauth")}
            />{" "}
            OAuth login
          </label>
          <label>
            <input
              type="radio"
              name="mode"
              checked={mode === "api_key"}
              onChange={() => setMode("api_key")}
            />{" "}
            Store Secret
          </label>
        </div>
      ) : null}

      {mode === "oauth" && oauthServices.length > 0 ? (
        <OAuthForm services={oauthServices} token={token} onStatus={onStatus} />
      ) : (
        <ApiKeyForm token={token} onStatus={onStatus} />
      )}
    </div>
  );
}

export function VaultPage() {
  const token = useQueryParam("token") ?? "";
  const [info, setInfo] = useState<LinkInfo | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await apiGet<LinkInfo>(`/api/link/info?token=${encodeURIComponent(token)}`);
      setInfo(data);
    } catch {
      setInfo({ valid: false });
    }
  }, [token]);

  useEffect(() => {
    if (!token) {
      setInfo({ valid: false });
      return;
    }
    void load();
  }, [token, load]);

  if (!token) {
    return (
      <div className="card">
        <p className="eyebrow">Vault</p>
        <h2 className="card-title">Login link required</h2>
        <div className="err-msg">
          This link is invalid or has expired. Ask the bot for a new <code>/login</code> link.
        </div>
      </div>
    );
  }

  if (!info) return <div className="loading-msg">Loading link…</div>;
  if (!info.valid) {
    return (
      <div className="card">
        <p className="eyebrow">Vault</p>
        <h2 className="card-title">Link expired</h2>
        <div className="err-msg">
          This link is invalid or has expired. Ask the bot for a new <code>/login</code> link.
        </div>
      </div>
    );
  }

  const hint = info.providerIdHint ?? null;
  const oauthServices = info.oauthServices ?? [];
  const hintLabel = oauthServices.find((s) => s.id === hint)?.label ?? "OAuth";

  return (
    <>
      <header className="page-head">
        <div>
          <p className="eyebrow">Vault</p>
          <h2 className="page-title">{hint ? hintLabel : "Store Secret"}</h2>
          <p className="page-desc">
            {info.expiresAt
              ? `Link expires ${new Date(info.expiresAt).toLocaleString()}`
              : "Store credentials in your vault."}
          </p>
        </div>
      </header>

      {info.existingSecrets ? <SecretsSummary secrets={info.existingSecrets} /> : null}

      <CredentialForm
        oauthServices={oauthServices}
        providerIdHint={hint}
        token={token}
        onStatus={setStatus}
      />
      {status ? <div className="inline-result ok">{status}</div> : null}
    </>
  );
}
