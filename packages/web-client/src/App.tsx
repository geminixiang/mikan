import {
  createBrowserRouter,
  Link,
  Navigate,
  Outlet,
  RouterProvider,
  useLocation,
} from "react-router-dom";
import { createContext, useContext } from "react";
import type { WebBootGraph } from "./manifest.js";
import { SessionPage } from "@geminixiang/mikan-ui-session";
import { AdminPage } from "@geminixiang/mikan-ui-admin";
import { VaultPage } from "@geminixiang/mikan-ui-vault";
import "./app.css";

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

function AppFrame() {
  const manifest = useManifest();
  const location = useLocation();
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
            <span className="topbar-user" title={`boot rev ${manifest.rev}`}>
              rev {manifest.rev.slice(0, 8)}
            </span>
          </div>
        </header>
        <Outlet />
      </main>
    </>
  );
}

export function App({ manifest }: { manifest: WebBootGraph }) {
  const router = createBrowserRouter([
    {
      element: <AppFrame />,
      children: [
        { path: "/", element: <Navigate to="/session" replace /> },
        { path: "/session", element: <SessionPage /> },
        { path: "/admin", element: <AdminPage /> },
        { path: "/link", element: <VaultPage /> },
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
