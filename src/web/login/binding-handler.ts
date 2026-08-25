import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebBindingStore } from "./binding.js";

/**
 * Handler for the web-binding and login flow.
 *
 * Routes:
 *   GET  /binding          — binding page (user enters their code + OAuth login)
 *   GET  /api/binding/info — returns binding info for a code
 *   GET  /login            — web login page (Sign in with GitHub)
 */

export function createBindingHandler(bindingTokenStore: WebBindingStore) {
  return (req: IncomingMessage, res: ServerResponse, url: URL): boolean => {
    if (req.method === "GET" && url.pathname === "/binding") {
      const code = url.searchParams.get("code") ?? "";
      const record = bindingTokenStore.peek(code);
      if (!record) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderPage("This code is invalid or has expired. Run `/login web` again in chat."));
        return true;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderPage("", code));
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/binding/info") {
      const code = url.searchParams.get("code") ?? "";
      const record = bindingTokenStore.peek(code);
      if (!record) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ valid: false }));
        return true;
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          valid: true,
          platform: record.platform,
          expiresAt: record.expiresAt,
        }),
      );
      return true;
    }

    if (req.method === "GET" && url.pathname === "/login") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderLoginPage());
      return true;
    }

    return false;
  };
}

function renderLoginPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in - mikan</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5; color: #333; }
.card { background: #fff; border-radius: 12px; padding: 2rem; box-shadow: 0 2px 8px rgba(0,0,0,0.1); max-width: 360px; width: 100%; text-align: center; }
h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
p { margin-bottom: 1.5rem; color: #666; }
button { width: 100%; padding: 0.75rem; border: none; border-radius: 6px; font-size: 1rem; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 0.5rem; }
button.github { background: #333; color: #fff; }
button.github:hover { background: #555; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
.error { color: #c00; margin-top: 1rem; }
</style>
</head>
<body>
<div class="card">
  <h1>mikan</h1>
  <p>Sign in to access the web interface.</p>
  <button class="github" onclick="login()">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
    Sign in with GitHub
  </button>
  <div id="status"></div>
</div>
<script>
async function login() {
  const btn = document.querySelector("button");
  btn.disabled = true;
  document.getElementById("status").innerHTML = '<p>Redirecting to GitHub...</p>';
  try {
    const resp = await fetch("/api/oauth/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "login", serviceId: "github", mode: "login" }),
    });
    const data = await resp.json();
    if (data.ok && data.redirectUrl) {
      window.location.href = data.redirectUrl;
    } else {
      document.getElementById("status").innerHTML = '<p class="error">' + escapeHtml(data.error || "Unknown error") + '</p>';
      btn.disabled = false;
    }
  } catch (e) {
    document.getElementById("status").innerHTML = '<p class="error">Network error. Please try again.</p>';
    btn.disabled = false;
  }
}
function escapeHtml(s) { return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
</script>
</body>
</html>`;
}

function renderPage(error: string, code = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Web Binding - mikan</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 480px; margin: 4rem auto; padding: 0 1rem; color: #333; }
h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
p { margin-bottom: 1.5rem; color: #666; }
label { font-weight: 600; display: block; margin-bottom: 0.25rem; }
input[type="text"] { width: 100%; padding: 0.5rem; border: 1px solid #ccc; border-radius: 4px; font-size: 1rem; box-sizing: border-box; }
button { width: 100%; padding: 0.75rem; background: #333; color: #fff; border: none; border-radius: 6px; font-size: 1rem; cursor: pointer; }
button:hover { background: #555; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
.error { color: #c00; margin-top: 1rem; }
.success { color: #090; margin-top: 1rem; }
</style>
</head>
<body>
<h1>Web Binding</h1>
<p>Link your chat account to the web interface.</p>
<div id="app">
  <label for="code">Binding Code</label>
  <input type="text" id="code" value="${escapeHtml(code)}" placeholder="ABC123" ${code ? "readonly" : ""}>
  <p style="margin-top: 1rem;">
    <button id="auth-btn" onclick="startOAuth()">Authorize with GitHub</button>
  </p>
  <div id="status"></div>
</div>
<script>
async function startOAuth() {
  const code = document.getElementById("code").value.trim();
  if (!code) { document.getElementById("status").innerHTML = '<p class="error">Please enter your binding code.</p>'; return; }
  document.getElementById("auth-btn").disabled = true;
  document.getElementById("status").innerHTML = '<p>Redirecting to GitHub...</p>';
  try {
    const resp = await fetch("/api/oauth/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: code, serviceId: "github", mode: "binding" }),
    });
    const data = await resp.json();
    if (data.ok && data.redirectUrl) {
      window.location.href = data.redirectUrl;
    } else {
      document.getElementById("status").innerHTML = '<p class="error">' + escapeHtml(data.error || "Unknown error") + '</p>';
      document.getElementById("auth-btn").disabled = false;
    }
  } catch (e) {
    document.getElementById("status").innerHTML = '<p class="error">Network error. Please try again.</p>';
    document.getElementById("auth-btn").disabled = false;
  }
}
function escapeHtml(s) { return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
