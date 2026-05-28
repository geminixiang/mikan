const serverUrlInput = document.getElementById("serverUrl");
const codeInput = document.getElementById("code");
const nameInput = document.getElementById("name");
const statusEl = document.getElementById("status");

async function load() {
  const state = await chrome.storage.local.get([
    "serverUrl",
    "browserId",
    "conversationId",
    "name",
  ]);
  serverUrlInput.value = state.serverUrl || "";
  nameInput.value = state.name || "";
  statusEl.textContent = state.browserId
    ? `Paired\nBrowser: ${state.browserId}\nConversation: ${state.conversationId || "unknown"}`
    : "Not paired";
}

async function pair() {
  const serverUrl = serverUrlInput.value.trim().replace(/\/+$/, "");
  const code = codeInput.value.trim();
  const name = nameInput.value.trim() || navigator.userAgent;
  if (!serverUrl || !code) {
    statusEl.textContent = "Server URL and pairing code are required.";
    return;
  }
  statusEl.textContent = "Pairing...";
  try {
    const resp = await fetch(`${serverUrl}/api/browser/pair/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, name }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    await chrome.storage.local.set({
      serverUrl,
      browserId: data.browserId,
      browserToken: data.token,
      conversationId: data.conversationId,
      name,
    });
    chrome.runtime.sendMessage({ type: "wake" });
    codeInput.value = "";
    await load();
  } catch (err) {
    statusEl.textContent = `Pair failed: ${err.message || err}`;
  }
}

async function forget() {
  await chrome.storage.local.clear();
  await load();
}

document.getElementById("pair").addEventListener("click", pair);
document.getElementById("forget").addEventListener("click", forget);
load();
