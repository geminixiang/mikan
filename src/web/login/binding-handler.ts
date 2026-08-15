import type { IncomingMessage, ServerResponse } from "node:http";
import type { InMemoryBindingTokenStore } from "./binding.js";

/**
 * Handler for the web-binding flow.
 *
 * Routes:
 *   GET  /binding          — binding page (user enters their code + OAuth login)
 *   GET  /api/binding/info — returns binding info for a code
 */

export function createBindingHandler(bindingTokenStore: InMemoryBindingTokenStore) {
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

    return false;
  };
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
form { display: flex; flex-direction: column; gap: 1rem; }
label { font-weight: 600; }
input[type="text"] { padding: 0.5rem; border: 1px solid #ccc; border-radius: 4px; font-size: 1rem; }
button { padding: 0.75rem; background: #333; color: #fff; border: none; border-radius: 6px; font-size: 1rem; cursor: pointer; }
button:hover { background: #555; }
.error { color: #c00; margin-top: 1rem; }
</style>
</head>
<body>
<h1>Web Binding</h1>
<p>Link your chat account to the web interface.</p>
<form action="/api/oauth/start" method="POST">
  <label for="code">Binding Code</label>
  <input type="text" id="code" name="code" value="${escapeHtml(code)}" placeholder="ABC123" required>
  <input type="hidden" name="mode" value="binding">
  <input type="hidden" name="serviceId" value="github">
  <button type="submit">Authorize with GitHub</button>
</form>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
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
