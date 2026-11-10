const STYLE = `
html, body { margin: 0; height: 100%; background: #1a1b26; color: #c0caf5;
  font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
body { display: flex; flex-direction: column; }
header { display: flex; align-items: center; gap: 12px; padding: 6px 12px;
  background: #16161e; border-bottom: 1px solid #292e42; }
header strong { font-weight: 600; letter-spacing: .02em; }
#state { color: #7a88cf; }
#screen { flex: 1; min-height: 0; }
`;

const SCRIPT = `
import RFB from "./desktop/novnc/core/rfb.js";

const token = new URLSearchParams(location.search).get("token") ?? "";
const query = "?token=" + encodeURIComponent(token);
const state = document.getElementById("state");
const wsUrl = new URL("desktop/ws" + query, location.href);
wsUrl.protocol = location.protocol === "https:" ? "wss:" : "ws:";

const rfb = new RFB(document.getElementById("screen"), wsUrl.href);
rfb.resizeSession = true;
rfb.scaleViewport = true;
rfb.focusOnClick = true;
rfb.addEventListener("connect", () => { state.textContent = "Connected"; rfb.focus(); });
rfb.addEventListener("disconnect", (event) => {
  state.textContent = event.detail.clean ? "Disconnected" : "Connection lost. Reload or ask for a new link.";
});
`;

export function renderDesktopPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Desktop — mikan</title>
<style>${STYLE}</style>
</head>
<body>
<header>
<strong>mikan desktop</strong>
<span id="state">Connecting…</span>
</header>
<div id="screen"></div>
<script type="module">${SCRIPT}</script>
</body>
</html>`;
}
