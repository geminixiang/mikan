import {
  createBrowserRouter,
  Link,
  Navigate,
  Outlet,
  RouterProvider,
  useLocation,
} from "react-router-dom";
import { createContext, useContext, useEffect, useState } from "react";
import type { WebBootGraph } from "./manifest.js";
import { SessionPage } from "@geminixiang/mikan-ui-session";
import { AdminPage } from "@geminixiang/mikan-ui-admin";
import { VaultPage } from "@geminixiang/mikan-ui-vault";
import "./app.css";

interface MeResponse {
  authenticated: boolean;
  oauthIdentity?: string;
  platforms?: Array<{ platform: string; platformUserId: string }>;
  expiresAt?: number;
}

const NAV = [
  {
    view: "session",
    label: "Session",
    path: "/session",
    svg: (
      <svg
        viewBox="0 0 24 24"
        width="20"
        height="20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
      </svg>
    ),
  },
  {
    view: "admin",
    label: "Admin",
    path: "/admin",
    svg: (
      <svg
        viewBox="0 0 24 24"
        width="20"
        height="20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    ),
  },
  {
    view: "vault",
    label: "Vault",
    path: "/link",
    svg: (
      <svg
        viewBox="0 0 24 24"
        width="20"
        height="20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
    ),
  },
] as const;

const ManifestContext = createContext<WebBootGraph | null>(null);

function useManifest(): WebBootGraph {
  const manifest = useContext(ManifestContext);
  if (manifest === null) throw new Error("web-client: App rendered without a boot manifest");
  return manifest;
}

/** Gate that redirects to /login when not authenticated. */
function AuthGate({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/me", { credentials: "same-origin" })
      .then((r) => r.json())
      .then((data: MeResponse) => {
        setMe(data);
        setLoading(false);
      })
      .catch(() => {
        setMe({ authenticated: false });
        setLoading(false);
      });
  }, []);

  if (loading)
    return (
      <div className="shell" style={{ padding: "2rem", textAlign: "center" }}>
        Loading...
      </div>
    );
  if (!me?.authenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AppFrame() {
  const manifest = useManifest();
  const location = useLocation();
  const [me, setMe] = useState<MeResponse | null>(null);

  useEffect(() => {
    fetch("/api/me", { credentials: "same-origin" })
      .then((r) => r.json())
      .then((data: MeResponse) => setMe(data))
      .catch(() => {});
  }, []);

  const activeView = NAV.find((n) => location.pathname.startsWith(n.path))?.view;
  const pageTitle = activeView === "admin" ? "Admin" : activeView === "vault" ? "Vault" : "Session";
  return (
    <>
      <nav className="floating-view-nav" aria-label="Primary views">
        {NAV.map((n) => {
          const isActive = n.view === activeView;
          const attrs = {
            "data-tooltip": n.label,
            "aria-label": n.label,
            className: `view-nav-btn${isActive ? " active" : ""}`,
          };
          return isActive ? (
            <span key={n.view} aria-current="page" {...attrs}>
              {n.svg}
            </span>
          ) : (
            <Link key={n.view} to={n.path} {...attrs}>
              {n.svg}
            </Link>
          );
        })}
      </nav>
      <main className="shell">
        <header className="topbar">
          <div className="topbar-brand">
            <span className="topbar-wordmark">mikan</span>
            <span className="topbar-sep">·</span>
            <span className="topbar-title">{pageTitle}</span>
          </div>
          <div className="topbar-meta">
            {me?.oauthIdentity && <span className="topbar-user">{me.oauthIdentity}</span>}
            <span className="topbar-rev" title={`boot rev ${manifest.rev}`}>
              rev {manifest.rev.slice(0, 8)}
            </span>
          </div>
        </header>
        <Outlet />
      </main>
    </>
  );
}

function LoginPage() {
  return (
    <div className="login-page">
      <div className="login-card">
        <h1>mikan</h1>
        <p>Sign in to access the web interface.</p>
        <button className="login-btn" onClick={doLogin}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
          </svg>
          Sign in with GitHub
        </button>
        <div id="status"></div>
      </div>
    </div>
  );
}

async function doLogin() {
  const btn = document.querySelector(".login-btn") as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  const status = document.getElementById("status");
  if (status) status.innerHTML = '<p style="color:#666">Redirecting to GitHub...</p>';
  try {
    const resp = await fetch("/api/oauth/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "login", serviceId: "github", mode: "login" }),
    });
    const data = await resp.json();
    if (data.ok && data.redirectUrl) {
      window.location.href = data.redirectUrl;
    } else if (status) {
      status.innerHTML = '<p style="color:#c00">' + (data.error || "Unknown error") + "</p>";
      if (btn) btn.disabled = false;
    }
  } catch {
    if (status) status.innerHTML = '<p style="color:#c00">Network error. Please try again.</p>';
    if (btn) btn.disabled = false;
  }
}

export function App({ manifest }: { manifest: WebBootGraph }) {
  const router = createBrowserRouter([
    {
      element: <AppFrame />,
      children: [
        { path: "/", element: <Navigate to="/session" replace /> },
        { path: "/login", element: <LoginPage /> },
        {
          path: "/session",
          element: (
            <AuthGate>
              <SessionPage />
            </AuthGate>
          ),
        },
        {
          path: "/admin",
          element: (
            <AuthGate>
              <AdminPage />
            </AuthGate>
          ),
        },
        {
          path: "/link",
          element: (
            <AuthGate>
              <VaultPage />
            </AuthGate>
          ),
        },
        { path: "*", element: <Navigate to="/session" replace /> },
      ],
    },
  ]);
  return (
    <ManifestContext.Provider value={manifest}>
      <RouterProvider router={router} />
    </ManifestContext.Provider>
  );
}
