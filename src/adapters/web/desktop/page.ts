const STYLE = `
html, body { margin: 0; height: 100%; background: #1a1b26; color: #c0caf5;
  font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
body { display: flex; flex-direction: column; }
header { display: flex; align-items: center; gap: 12px; padding: 6px 12px;
  background: #16161e; border-bottom: 1px solid #292e42; }
header strong { font-weight: 600; letter-spacing: .02em; }
#state { color: #7a88cf; }
#owner { margin-left: auto; color: #9ece6a; }
#owner[data-owner="user"] { color: #e0af68; }
button { font: inherit; color: #1a1b26; background: #7aa2f7; border: 0; border-radius: 6px;
  padding: 4px 12px; cursor: pointer; }
button:disabled { opacity: .5; cursor: default; }
#screen { flex: 1; min-height: 0; }
`;

const SCRIPT = `
import RFB from "./desktop/novnc/core/rfb.js";

const token = new URLSearchParams(location.search).get("token") ?? "";
const query = "?token=" + encodeURIComponent(token);
const state = document.getElementById("state");
const owner = document.getElementById("owner");
const toggle = document.getElementById("toggle");
const wsUrl = new URL("desktop/ws" + query, location.href);
wsUrl.protocol = location.protocol === "https:" ? "wss:" : "ws:";

const rfb = new RFB(document.getElementById("screen"), wsUrl.href);
rfb.resizeSession = true;
rfb.scaleViewport = true;
rfb.focusOnClick = true;
rfb.addEventListener("connect", () => { state.textContent = "Connected"; rfb.focus(); });
rfb.addEventListener("disconnect", (event) => {
  clearInterval(polling);
  toggle.disabled = true;
  state.textContent = event.detail.clean ? "Disconnected" : "Connection lost. Reload or ask for a new link.";
});

function showOwner(value) {
  owner.dataset.owner = value;
  owner.textContent = value === "user" ? "You control the browser" : "The agent controls the browser";
  toggle.textContent = value === "user" ? "Hand back to agent" : "Take control";
  toggle.disabled = false;
}

async function control(method, body) {
  const response = await fetch("desktop/control" + query, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.ok) showOwner((await response.json()).owner);
}

toggle.addEventListener("click", () => {
  toggle.disabled = true;
  control("POST", { owner: owner.dataset.owner === "user" ? "agent" : "user" });
});
control("GET");
const polling = setInterval(() => control("GET"), 5000);
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
<span id="owner"></span>
<button id="toggle" type="button" disabled>Take control</button>
</header>
<div id="screen"></div>
<script type="module">${SCRIPT}</script>
</body>
</html>`;
}
