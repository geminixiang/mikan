const POLL_MS = 2000;
const DEFAULT_WAIT_TIMEOUT_MS = 15000;
const DEFAULT_WAIT_INTERVAL_MS = 500;
const DEFAULT_RELOAD_INTERVAL_MS = 1500;
const DEFAULT_RELOAD_ATTEMPTS = 20;
let polling = false;

async function getState() {
  return chrome.storage.local.get(["serverUrl", "browserId", "browserToken"]);
}

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs[0];
}

function slimTab(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    active: tab.active,
    highlighted: tab.highlighted,
    title: tab.title,
    url: tab.url,
    status: tab.status,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeTimeout(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

function normalizeDomainLikeMatch(value) {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/$/, "");
}

async function resolveTabId(payload) {
  const tabId = Number(payload.tabId);
  if (tabId) return tabId;
  const tab = await activeTab();
  if (!tab?.id) throw new Error("No active tab available");
  return tab.id;
}

async function runInTab(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
  });
  return results[0]?.result;
}

async function inspectTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const details = await runInTab(tabId, () => {
    const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
    const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
      .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 10);
    return {
      readyState: document.readyState,
      title: document.title,
      url: location.href,
      textSnippet: text.slice(0, 4000),
      headings,
      forms: document.forms.length,
      links: document.links.length,
      iframes: document.querySelectorAll("iframe").length,
    };
  });
  return { tab: slimTab(tab), ...details };
}

async function findElements(tabId, payload) {
  const selector = typeof payload.selector === "string" ? payload.selector.trim() : "";
  const maxResults = normalizeTimeout(payload.maxResults, 20);
  if (!selector) throw new Error("selector is required");

  return runInTab(
    tabId,
    ({ selector: nextSelector, maxResults: nextMaxResults }) => {
      const nodes = Array.from(document.querySelectorAll(nextSelector)).slice(0, nextMaxResults);
      return {
        selector: nextSelector,
        count: document.querySelectorAll(nextSelector).length,
        matches: nodes.map((node) => ({
          text: (node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 500),
          html: node instanceof Element ? node.outerHTML.slice(0, 1000) : undefined,
          tagName: node instanceof Element ? node.tagName.toLowerCase() : undefined,
        })),
      };
    },
    [{ selector, maxResults }],
  );
}

async function findIframes(tabId, payload) {
  const srcIncludes = normalizeDomainLikeMatch(payload.srcIncludes);
  const maxResults = normalizeTimeout(payload.maxResults, 20);

  return runInTab(
    tabId,
    ({ srcIncludes: nextSrcIncludes, maxResults: nextMaxResults }) => {
      const all = Array.from(document.querySelectorAll("iframe"));
      const filtered = nextSrcIncludes
        ? all.filter((iframe) => {
            const src = (iframe.src || "").replace(/^https?:\/\//i, "");
            return src.includes(nextSrcIncludes);
          })
        : all;
      return {
        srcIncludes: nextSrcIncludes || undefined,
        count: filtered.length,
        matches: filtered.slice(0, nextMaxResults).map((iframe) => ({
          src: iframe.src || "",
          title: iframe.title || "",
          id: iframe.id || "",
          className: iframe.className || "",
        })),
      };
    },
    [{ srcIncludes, maxResults }],
  );
}

async function checkCondition(tabId, payload) {
  const selector = typeof payload.selector === "string" ? payload.selector.trim() : "";
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!selector && !text) {
    throw new Error("selector or text is required");
  }

  return runInTab(
    tabId,
    ({ selector: nextSelector, text: nextText }) => {
      const bodyText = (document.body?.innerText || "").replace(/\s+/g, " ");
      const matches = [];
      if (nextSelector) {
        const node = document.querySelector(nextSelector);
        if (node) {
          const html = node instanceof Element ? node.outerHTML.slice(0, 1000) : undefined;
          matches.push({
            type: "selector",
            selector: nextSelector,
            text: (node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 500),
            html,
          });
        }
      }
      if (nextText && bodyText.includes(nextText)) {
        matches.push({ type: "text", text: nextText });
      }
      return {
        ok: matches.length > 0,
        readyState: document.readyState,
        title: document.title,
        url: location.href,
        matches,
      };
    },
    [{ selector, text }],
  );
}

async function waitForCondition(tabId, payload) {
  const timeoutMs = normalizeTimeout(payload.timeoutMs, DEFAULT_WAIT_TIMEOUT_MS);
  const intervalMs = normalizeTimeout(payload.intervalMs, DEFAULT_WAIT_INTERVAL_MS);
  const startedAt = Date.now();
  let last = null;

  while (Date.now() - startedAt <= timeoutMs) {
    last = await checkCondition(tabId, payload);
    if (last?.ok) {
      return {
        ...last,
        elapsedMs: Date.now() - startedAt,
        attempts: Math.max(1, Math.ceil((Date.now() - startedAt) / intervalMs)),
      };
    }
    await sleep(intervalMs);
  }

  return {
    ok: false,
    elapsedMs: Date.now() - startedAt,
    last,
    error: "Timed out waiting for browser condition",
  };
}

async function executeCommand(command) {
  const payload = command.payload || {};
  switch (command.type) {
    case "list_tabs": {
      const tabs = await chrome.tabs.query({});
      return { tabs: tabs.map(slimTab) };
    }
    case "open_tab": {
      const tab = await chrome.tabs.create({ url: String(payload.url) });
      return { tab: slimTab(tab) };
    }
    case "activate_tab": {
      const tabId = Number(payload.tabId);
      if (!tabId) throw new Error("tabId is required");
      const tab = await chrome.tabs.update(tabId, { active: true });
      if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
      return { tab: slimTab(tab) };
    }
    case "reload_tab": {
      const tabId = await resolveTabId(payload);
      await chrome.tabs.reload(tabId);
      await waitForTabComplete(tabId, 15000).catch(() => undefined);
      const tab = await chrome.tabs.get(tabId);
      return { tab: slimTab(tab) };
    }
    case "get_active_tab": {
      const tab = await activeTab();
      return { tab: tab ? slimTab(tab) : null };
    }
    case "screenshot": {
      const tab = await activeTab();
      const windowId = Number(payload.windowId) || tab?.windowId;
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
      return { dataUrl, url: tab?.url, title: tab?.title, windowId };
    }
    case "wait_for": {
      const tabId = await resolveTabId(payload);
      const result = await waitForCondition(tabId, payload);
      const tab = await chrome.tabs.get(tabId);
      return { tab: slimTab(tab), ...result };
    }
    case "reload_until": {
      const tabId = await resolveTabId(payload);
      const maxAttempts = normalizeTimeout(payload.maxAttempts, DEFAULT_RELOAD_ATTEMPTS);
      const intervalMs = normalizeTimeout(payload.intervalMs, DEFAULT_RELOAD_INTERVAL_MS);
      const timeoutMs = normalizeTimeout(payload.timeoutMs, DEFAULT_WAIT_TIMEOUT_MS);
      let lastCheck = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        await chrome.tabs.reload(tabId);
        await waitForTabComplete(tabId, timeoutMs).catch(() => undefined);
        lastCheck = await waitForCondition(tabId, {
          ...payload,
          timeoutMs: intervalMs,
          intervalMs: Math.min(intervalMs, 500),
        });
        if (lastCheck?.ok) {
          const tab = await chrome.tabs.get(tabId);
          return { tab: slimTab(tab), ok: true, attempt, result: lastCheck };
        }
      }
      const tab = await chrome.tabs.get(tabId);
      return {
        tab: slimTab(tab),
        ok: false,
        attempts: maxAttempts,
        result: lastCheck,
        error: "Condition not satisfied before maxAttempts",
      };
    }
    case "inspect_page": {
      const tabId = await resolveTabId(payload);
      return inspectTab(tabId);
    }
    case "find_elements": {
      const tabId = await resolveTabId(payload);
      const result = await findElements(tabId, payload);
      const tab = await chrome.tabs.get(tabId);
      return { tab: slimTab(tab), ...result };
    }
    case "find_iframes": {
      const tabId = await resolveTabId(payload);
      const result = await findIframes(tabId, payload);
      const tab = await chrome.tabs.get(tabId);
      return { tab: slimTab(tab), ...result };
    }
    default:
      throw new Error(`Unknown command type: ${command.type}`);
  }
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Timed out waiting for tab load"));
    }, timeoutMs);
    function listener(updatedTabId, changeInfo, tab) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(tab);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function postResult(state, command, result) {
  await fetch(`${state.serverUrl}/api/browser/commands/${encodeURIComponent(command.id)}/result`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${state.browserToken}`,
    },
    body: JSON.stringify({ browserId: state.browserId, ...result }),
  });
}

async function pollOnce() {
  const state = await getState();
  if (!state.serverUrl || !state.browserId || !state.browserToken) return;

  const resp = await fetch(
    `${state.serverUrl}/api/browser/commands?browserId=${encodeURIComponent(state.browserId)}`,
    { headers: { authorization: `Bearer ${state.browserToken}` } },
  );
  if (!resp.ok) return;
  const data = await resp.json();
  for (const command of data.commands || []) {
    try {
      const commandData = await executeCommand(command);
      await postResult(state, command, { ok: true, data: commandData });
    } catch (err) {
      await postResult(state, command, { ok: false, error: err.message || String(err) });
    }
  }
}

function startPolling() {
  if (!polling) {
    polling = true;
    setInterval(() => pollOnce().catch(() => undefined), POLL_MS);
  }
  chrome.alarms.create("mama-poll", { periodInMinutes: 0.5 });
  pollOnce().catch(() => undefined);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "mama-poll") pollOnce().catch(() => undefined);
});
chrome.runtime.onStartup.addListener(startPolling);
chrome.runtime.onInstalled.addListener(startPolling);
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "wake") startPolling();
});
startPolling();
