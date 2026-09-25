export const adminViewFunctionsScript = `    let activeConversationKey = defaultConversationKey;
    function scopeOf(key) {
      const sep = key.indexOf(':');
      return { platform: key.slice(0, sep), conversationId: key.slice(sep + 1) };
    }
    function scopeQuery() {
      const scope = scopeOf(activeConversationKey);
      return 'conversationId=' + encodeURIComponent(scope.conversationId) +
        '&platform=' + encodeURIComponent(scope.platform);
    }
    function scopeBody() {
      const scope = scopeOf(activeConversationKey);
      return { conversationId: scope.conversationId, platform: scope.platform };
    }
    let availableModels = [];
    let modelsLoaded = false;
    let mcpPresets = [];
    let mcpServersByScope = { conversation: {}, global: {} };
    let pendingMcpInstall = null;


    function escHtml(str) {
      return String(str).replace(/[&<>"']/g, (c) => (
        {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]
      ));
    }
    const escAttr = escHtml;
    async function copyToClipboard(text) {
      try { await navigator.clipboard.writeText(text); } catch { prompt('Copy this link:', text); }
    }
    document.addEventListener('click', (event) => {
      const target = event.target instanceof Element
        ? event.target.closest('[data-admin-action]')
        : null;
      if (!target) return;
      switch (target.dataset.adminAction) {
        case 'preview-file':
          void previewFile(target.dataset.filePath || '');
          break;
        case 'copy-link':
          void copyToClipboard(target.dataset.copyText || '');
          break;
        case 'delete-event':
          void deleteEvent(target.dataset.eventName || '', target);
          break;
        case 'select-conversation':
          setActiveConversation(target.dataset.conversationId || '');
          switchTab('conversation');
          break;
        case 'toggle-timeline-filter':
          toggleTimelineFilter(target.dataset.filterKey || '');
          break;
      }
    });
    async function apiGet(path) {
      const url = path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(adminToken);
      const r = await fetch(url);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
      return data;
    }
    async function apiPost(path, body) {
      const r = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: adminToken, ...body }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
      return data;
    }
    async function loadModels() {
      try {
        const data = await apiGet('/admin/api/models');
        availableModels = Array.isArray(data.models) ? data.models : [];
      } catch (err) {
        availableModels = [];
      } finally {
        modelsLoaded = true;
      }
    }
    function modelRef(provider, model) {
      return provider && model ? provider + '/' + model : '';
    }
    function parseModelRef(value) {
      const slash = value.indexOf('/');
      if (slash <= 0 || slash === value.length - 1) return { provider: '', model: '' };
      return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
    }
    function renderModelOptions(currentProvider, currentModel) {
      const current = modelRef(currentProvider, currentModel);
      const seen = new Set();
      const groups = {
        available: [],
        unverified: [],
      };
      if (current) {
        seen.add(current);
        groups.available.push('<option value="' + escAttr(current) + '">' + escHtml(current + ' (current)') + '</option>');
      }
      for (const model of availableModels) {
        const ref = modelRef(model.provider, model.id);
        if (!ref || seen.has(ref)) continue;
        seen.add(ref);
        const details = [model.name && model.name !== model.id ? model.name : '', model.reasoning ? 'thinking' : '', Array.isArray(model.input) && model.input.includes('image') ? 'image' : '']
          .filter(Boolean)
          .join(' · ');
        const option = '<option value="' + escAttr(ref) + '">' + escHtml(details ? ref + ' — ' + details : ref) + '</option>';
        if (model.status === 'unverified') groups.unverified.push(option);
        else groups.available.push(option);
      }
      const sections = [];
      if (groups.available.length > 0) sections.push('<optgroup label="Available">' + groups.available.join('') + '</optgroup>');
      if (groups.unverified.length > 0) sections.push('<optgroup label="Configured but unverified">' + groups.unverified.join('') + '</optgroup>');
      if (sections.length === 0) {
        return '<option value="">No available models</option>';
      }
      return sections.join('');
    }


    const scopeBtns = document.querySelectorAll('.rail-scope-btn');
    const tabPanels = document.querySelectorAll('.tab-panel');
    const railNavConversation = document.getElementById('rail-nav-conversation');
    const railNavGlobal = document.getElementById('rail-nav-global');

    function switchTab(tabId) {
      scopeBtns.forEach((btn) => {
        const active = btn.dataset.tab === tabId;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      tabPanels.forEach((panel) => panel.classList.toggle('active', panel.id === 'panel-' + tabId));
      railNavConversation.hidden = tabId !== 'conversation';
      railNavGlobal.hidden = tabId !== 'global';
      if (tabId === 'global') initGlobal();
      const firstPane = (tabId === 'global' ? railNavGlobal : railNavConversation).querySelector('.rail-link');
      if (firstPane) selectPane(tabId, firstPane.dataset.pane);
    }
    scopeBtns.forEach((btn) => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));


    function paneLoader(key) {
      switch (key) {
        case 'settings': return loadSettings;
        case 'workspace': return loadWorkspace;
        case 'skills': return loadSkills;
        case 'mcp': return loadMcpServers;
        case 'events': return loadConversationEvents;
        case 'g-overview': return loadAllConversations;
        case 'g-usage': return loadTokenUsage;
        case 'g-settings': return loadGlobalSettings;
        case 'g-mcp': return loadMcpServers;
        case 'g-skills': return loadGlobalSkills;
        case 'g-events': return loadEvents;
        default: return undefined;
      }
    }
    const paneLoaded = new Set();

    function ensurePaneLoaded(key) {
      if (paneLoaded.has(key)) return;
      const loader = paneLoader(key);
      if (!loader) return;
      paneLoaded.add(key);
      loader();
    }

    function selectPane(scope, key) {
      const nav = scope === 'global' ? railNavGlobal : railNavConversation;
      const panel = document.getElementById(scope === 'global' ? 'panel-global' : 'panel-conversation');
      nav.querySelectorAll('.rail-link').forEach((btn) => {
        const active = btn.dataset.pane === key;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-current', active ? 'page' : 'false');
      });
      panel.querySelectorAll('.pane').forEach((pane) => {
        pane.classList.toggle('active', pane.dataset.pane === key);
      });
      ensurePaneLoaded(key);
    }

    function initRailNav() {
      document.querySelectorAll('.rail-link').forEach((btn) => {
        btn.addEventListener('click', () => {
          const nav = btn.closest('.rail-nav');
          const scope = nav.dataset.scope;
          selectPane(scope, btn.dataset.pane);
        });
      });
      selectPane('conversation', 'settings');
    }


    async function initConvSwitcher() {
      const sel = document.getElementById('conv-switcher');
      try {
        const data = await apiGet('/admin/api/conversations');
        sel.innerHTML = data.conversations.map((c) => {
          const key = c.platform + ':' + c.conversationId;
          const label = (c.label || c.conversationId) + (c.running ? ' (running)' : '');
          const selected = key === defaultConversationKey ? ' selected' : '';
          return '<option value="' + escAttr(key) + '"' + selected + '>' + escHtml(label) + '</option>';
        }).join('');
        sel.addEventListener('change', () => setActiveConversation(sel.value));
      } catch (err) {
      }
    }

    function setActiveConversation(key) {
      activeConversationKey = key;
      const sel = document.getElementById('conv-switcher');
      if (sel && sel.value !== key) sel.value = key;
      const activeLink = railNavConversation.querySelector('.rail-link.active');
      ['settings', 'workspace', 'skills', 'mcp', 'events'].forEach((key) => paneLoaded.delete(key));
      if (activeLink) ensurePaneLoaded(activeLink.dataset.pane);
      openLogin(true);
      openSessionView(true);
    }


    const loadSettings = () => loadSettingsPanel('settings-content', () => '/admin/api/conversation-state?' + scopeQuery(), renderSettings);
    const loadGlobalSettings = () => loadSettingsPanel('global-settings-content', () => '/admin/api/settings/global', renderGlobalSettings);

    async function loadSettingsPanel(id, path, render) {
      const container = document.getElementById(id);
      container.innerHTML = '<div class="loading-msg">Loading…</div>';
      if (!modelsLoaded) await loadModels();
      try {
        const data = await apiGet(path());
        container.innerHTML = render(data);
      } catch (err) {
        container.innerHTML = '<div class="err-msg">' + escHtml(err.message) + '</div>';
      }
    }

    function renderConfigCard(title, content, action, buttonLabel, resultId) {
      return '<div class="config-block"><h3 class="card-subtitle">' + title + '</h3>' + content +
        '<button class="primary-action-btn" onclick="' + action + '(this)">' + buttonLabel + '</button>' +
        '<div id="' + resultId + '" class="inline-result" style="display:none"></div></div>';
    }

    function renderOptions(choices, selected) {
      return choices.map(([value, label]) =>
        '<option value="' + escAttr(value) + '"' + (selected === value ? ' selected' : '') + '>' + escHtml(label) + '</option>'
      ).join('');
    }
    function renderThinkingOptions(value) {
      return renderOptions(['off','minimal','low','medium','high','xhigh','max'].map((t) => [t, t]), value);
    }
    function renderReplyOptions(slack) {
      return renderOptions(['top-level','thread'].map((m) => [m, m]), (slack && slack.replyMode) || 'top-level');
    }
    function renderSettings(data) {
      const thinkingOpts = renderThinkingOptions(data.thinkingLevel);
      const replyModeOpts = renderReplyOptions(data.slack);
      const globalReplyMode = (data.slack && data.slack.globalReplyMode) || 'top-level';
      const globalModel = [data.globalProvider, data.globalModel].filter(Boolean).join('/');
      const globalModelLabel = globalModel + (data.globalThinkingLevel ? ':' + data.globalThinkingLevel : '');
      return [
        '<div class="config-grid">',
          renderConfigCard('Model', [
            '<div class="config-row config-row-stack"><label>Model</label><select id="m-model-ref">' + renderModelOptions(data.provider, data.model) + '</select></div>',
            '<div class="config-row"><label>Thinking</label><select id="m-thinking">' + thinkingOpts + '</select></div>',
            '<p class="muted-note">Global default: ' + escHtml(globalModelLabel) + '</p>',
          ].join(''), 'saveModel', 'Save model', 'model-save-result'),

          renderVisibilityCard(data),
          renderConfigCard('Slack', [
            '<div class="config-row"><label>Reply mode</label><select id="m-slack-reply-mode">' + replyModeOpts + '</select></div>',
            '<p class="muted-note">Global default: ' + escHtml(globalReplyMode) + '</p>',
          ].join(''), 'saveSlack', 'Save Slack', 'slack-save-result'),
        '</div>',
      ].join('');
    }

    async function saveModel(btn) {
      const selectedModel = parseModelRef(document.getElementById('m-model-ref').value.trim());
      const provider = selectedModel.provider;
      const model = selectedModel.model;
      const thinkingLevel = document.getElementById('m-thinking').value;
      const result = document.getElementById('model-save-result');
      if (!provider || !model) {
        result.style.display = 'block'; result.className = 'inline-result err';
        result.textContent = 'Provider and model are required';
        return;
      }
      await saveConversationSetting(btn, result, 'model', { provider, model, thinkingLevel }, 'Save model');
    }

    async function saveSlack(btn) {
      const replyMode = document.getElementById('m-slack-reply-mode').value;
      const result = document.getElementById('slack-save-result');
      await saveConversationSetting(btn, result, 'slack', { replyMode }, 'Save Slack');
    }

    function renderVisibilityCard(data) {
      const hidden = data.officeVisibilityOverride === 'private';
      const canChoose = data.officeVisibilitySource === 'platform' ? data.officeVisibility === 'public' : hidden;
      if (!canChoose) {
        const why = data.officeVisibilitySource === 'platform'
          ? 'This is a DM, a private channel, or a conversation on a platform other than Slack, so its files are hidden from every other office. The platform decides this; it cannot be opened up here.'
          : 'Slack has not reported what kind of conversation this is yet, so it is treated as hidden until it does.';
        return '<div class="config-block"><h3 class="card-subtitle">Who can see the files in this office</h3>' +
          '<p><strong>Hidden</strong> — only this office.</p><p class="muted-note">' + why + '</p></div>';
      }
      return renderConfigCard('Who can see the files in this office', [
        '<div class="config-row"><label><input type="checkbox" id="m-visibility"' + (hidden ? ' checked' : '') + '> Hide the files in this channel from other offices</label></div>',
        '<p>' + (hidden
          ? '<strong>Hidden</strong> — other offices cannot read the files in this channel, and it can read shared MEMORY.md and skills but not change them.'
          : '<strong>Shared</strong> — every other office can read the files in this channel (read-only), and this channel may update shared MEMORY.md and skills.') + '</p>',
        '<p class="muted-note">Slack says this is a public channel, which is why sharing is the default. Hiding is the only change allowed; nothing can be made more visible than Slack allows.</p>',
      ].join(''), 'saveVisibility', 'Save', 'mount-save-result');
    }

    async function saveVisibility(btn) {
      const visibility = document.getElementById('m-visibility').checked ? 'private' : 'default';
      const result = document.getElementById('mount-save-result');
      await saveConversationSetting(btn, result, 'visibility', { visibility }, 'Save visibility', loadSettings);
    }

    function saveConversationSetting(btn, result, setting, values, label, onSaved) {
      return saveSetting(btn, result, 'conversations/' + setting, { ...scopeBody(), ...values }, label, onSaved);
    }

    async function saveSetting(btn, result, path, values, label, onSaved) {
      btn.disabled = true; btn.textContent = 'Saving…'; result.style.display = 'none';
      try {
        await apiPost('/admin/api/' + path, values);
        result.style.display = 'block'; result.className = 'inline-result ok'; result.textContent = 'Saved ✓';
        if (onSaved) onSaved();
      } catch (err) {
        result.style.display = 'block'; result.className = 'inline-result err'; result.textContent = err.message;
      } finally {
        btn.disabled = false; btn.textContent = label;
      }
    }


    async function loadWorkspace() {
      const treeEl = document.getElementById('workspace-tree');
      const previewEl = document.getElementById('workspace-preview');
      treeEl.innerHTML = '<div class="loading-msg">Loading…</div>';
      previewEl.innerHTML = '<div class="placeholder-msg">Click a file to preview</div>';
      try {
        const data = await apiGet('/admin/api/workspace/tree?' + scopeQuery());
        if (!data.tree) {
          treeEl.innerHTML = '<div class="empty-state">No files</div>';
          return;
        }
        treeEl.innerHTML = '<ul class="tree-root">' + renderTreeChildren(data.tree) + '</ul>';
      } catch (err) {
        treeEl.innerHTML = '<div class="err-msg">' + escHtml(err.message) + '</div>';
      }
    }

    function renderTreeChildren(node) {
      if (node.type === 'file') {
        return '<li><button class="tree-file" data-admin-action="preview-file" data-file-path="' + escAttr(node.path) + '">' + escHtml(node.name) + '</button></li>';
      }
      if (!node.children || node.children.length === 0) {
        return '<li><span class="tree-dir empty">' + escHtml(node.name || '.') + '/</span></li>';
      }
      const inner = node.children.map((c) =>
        c.type === 'file'
          ? '<li><button class="tree-file" data-admin-action="preview-file" data-file-path="' + escAttr(c.path) + '">' + escHtml(c.name) + '</button></li>'
          : '<li><details open><summary class="tree-dir">' + escHtml(c.name) + '/</summary><ul>' + renderTreeChildren(c) + '</ul></details></li>'
      ).join('');
      return inner;
    }

    function renderPreviewFileResult(previewEl, label, data) {
      if (data.binary) {
        previewEl.innerHTML = '<div class="preview-meta">' + escHtml(label) + ' · ' + data.size + ' bytes · binary</div><div class="placeholder-msg">Binary file — preview not available</div>';
        return;
      }
      previewEl.innerHTML =
        '<div class="preview-meta">' + escHtml(label) + ' · ' + data.size + ' bytes</div>' +
        '<pre class="preview-body">' + escHtml(data.content || '') + '</pre>';
    }

    async function previewFile(path) {
      const previewEl = document.getElementById('workspace-preview');
      previewEl.innerHTML = '<div class="loading-msg">Loading ' + escHtml(path) + '…</div>';
      try {
        const data = await apiGet('/admin/api/workspace/file?' + scopeQuery() + '&path=' + encodeURIComponent(path));
        renderPreviewFileResult(previewEl, path, data);
      } catch (err) {
        previewEl.innerHTML = '<div class="err-msg">' + escHtml(err.message) + '</div>';
      }
    }


    async function loadScopePanels(prefix, endpoint, render) {
      const convEl = document.getElementById(prefix + '-conv-content');
      const globalEl = document.getElementById(prefix + '-global-content');
      if (convEl) convEl.innerHTML = '<div class="loading-msg">Loading…</div>';
      if (globalEl) globalEl.innerHTML = '<div class="loading-msg">Loading…</div>';
      try {
        const data = await apiGet('/admin/api/' + endpoint + '?' + scopeQuery());
        render(data, convEl, globalEl);
      } catch (err) {
        if (convEl) convEl.innerHTML = '<div class="err-msg">' + escHtml(err.message) + '</div>';
        if (globalEl) globalEl.innerHTML = '<div class="err-msg">' + escHtml(err.message) + '</div>';
      }
    }


    function mcpMessage(scope, text, kind) {
      const el = document.getElementById(scope === 'global' ? 'mcp-global-msg' : 'mcp-conv-msg');
      if (!el) return;
      el.style.display = 'block';
      el.className = 'status-msg status-msg-' + kind;
      el.textContent = text;
    }

    function mcpTransport(server) {
      return server.command
        ? server.command + (server.args && server.args.length ? ' ' + server.args.join(' ') : '')
        : (server.url || '');
    }

    function renderMcpServer(scope, name, server) {
      const transport = (server.command ? 'stdio: ' : 'http: ') + mcpTransport(server);
      const keys = [];
      if (server.envKeys && server.envKeys.length) keys.push('env: ' + server.envKeys.join(', '));
      if (server.headerKeys && server.headerKeys.length) keys.push('headers: ' + server.headerKeys.join(', '));
      return '<article class="mcp-preset mcp-installed-card">' +
        '<div class="mcp-preset-top">' +
          '<span class="mcp-preset-category">' + (server.command ? 'STDIO' : 'HTTP') + '</span>' +
          (server.disabled ? '<span class="mcp-badge mcp-badge-warn">disabled</span>' : '<span class="mcp-badge mcp-badge-ok">enabled</span>') +
        '</div>' +
        '<h3>' + escHtml(name) + '</h3>' +
        '<p class="mcp-preset-meta mcp-installed-transport">' + escHtml(transport) + '</p>' +
        (keys.length ? '<div class="mcp-preset-meta">' + escHtml(keys.join(' · ')) + '</div>' : '') +
        '<div class="mcp-preset-actions">' +
          '<button class="mcp-btn" data-mcp-action="test" data-mcp-scope="' + scope + '" data-mcp-name="' + escAttr(name) + '">Test</button>' +
          '<button class="mcp-btn" data-mcp-action="toggle" data-mcp-scope="' + scope + '" data-mcp-name="' + escAttr(name) + '">' + (server.disabled ? 'Enable' : 'Disable') + '</button>' +
          '<button class="mcp-btn mcp-btn-danger" data-mcp-action="remove" data-mcp-scope="' + scope + '" data-mcp-name="' + escAttr(name) + '">Remove</button>' +
        '</div>' +
      '</article>';
    }

    function renderMcpPreset(scope, preset, servers) {
      const installed = Boolean(servers[preset.serverName]);
      const transport = preset.server.command ? 'Runs on host' : 'Remote service';
      return '<article class="mcp-preset">' +
        '<div class="mcp-preset-top">' +
          '<span class="mcp-preset-category">' + escHtml(preset.category) + '</span>' +
          (installed ? '<span class="mcp-badge mcp-badge-ok">Installed here</span>' : '') +
        '</div>' +
        '<h3>' + escHtml(preset.name) + '</h3>' +
        '<p>' + escHtml(preset.description) + '</p>' +
        '<div class="mcp-preset-meta">' + escHtml(transport) + ' · <code>' + escHtml(preset.serverName) + '</code></div>' +
        '<div class="mcp-preset-actions">' +
          '<a href="' + escAttr(preset.sourceUrl) + '" target="_blank" rel="noopener">Source ↗</a>' +
          '<button class="primary-action-btn" data-mcp-action="preset" data-mcp-scope="' + scope + '" data-mcp-preset="' + escAttr(preset.id) + '">' + (installed ? 'Review' : 'Install') + '</button>' +
        '</div>' +
      '</article>';
    }

    function renderMcpScope(el, scope, servers) {
      const presets = mcpPresets.map((preset) => renderMcpPreset(scope, preset, servers)).join('');
      const rows = Object.entries(servers).map(([name, server]) => renderMcpServer(scope, name, server)).join('');
      el.innerHTML =
        '<div class="mcp-market-head"><div><h3>Explore presets</h3><p>Reviewed recipes that install into this scope.</p></div><span>' + mcpPresets.length + ' available</span></div>' +
        '<div class="mcp-preset-grid">' + presets + '</div>' +
        '<details class="mcp-installed" open><summary>Installed in this scope</summary>' +
          '<div class="mcp-preset-grid">' +
            rows +
            '<button type="button" class="mcp-add-card" data-mcp-action="open-custom" data-mcp-scope="' + scope + '">' +
              '<span class="mcp-add-card-plus">+</span><span>新增 server</span>' +
            '</button>' +
          '</div>' +
        '</details>';
    }

    function renderMcpGuidedForm(scope) {
      return '<div class="mcp-guided-grid">' +
        '<label class="mcp-field"><span>Server 名稱</span><input id="mcp-' + scope + '-g-name" class="form-input mcp-json" placeholder="例如 github" autocomplete="off" /></label>' +
        '<div class="mcp-transport-toggle">' +
          '<label><input type="radio" name="mcp-' + scope + '-g-transport" value="stdio" checked /> 本機指令 (stdio)</label>' +
          '<label><input type="radio" name="mcp-' + scope + '-g-transport" value="http" /> 遠端服務 (HTTP)</label>' +
        '</div>' +
        '<div id="mcp-' + scope + '-g-stdio" class="mcp-transport-fields">' +
          '<label class="mcp-field"><span>指令</span><input id="mcp-' + scope + '-g-command" class="form-input mcp-json" placeholder="npx" autocomplete="off" /></label>' +
          '<label class="mcp-field"><span>參數（以逗號分隔）</span><input id="mcp-' + scope + '-g-args" class="form-input mcp-json" placeholder="-y, @modelcontextprotocol/server-github" autocomplete="off" /></label>' +
        '</div>' +
        '<div id="mcp-' + scope + '-g-http" class="mcp-transport-fields" style="display:none">' +
          '<label class="mcp-field"><span>URL</span><input id="mcp-' + scope + '-g-url" class="form-input mcp-json" placeholder="https://mcp.example.com/mcp" autocomplete="off" /></label>' +
        '</div>' +
        '<div class="mcp-kv-block">' +
          '<div class="mcp-kv-head"><span id="mcp-' + scope + '-g-kv-label">環境變數 (env)</span><button type="button" class="mcp-btn" data-mcp-kv-add="' + scope + '">+ 新增一列</button></div>' +
          '<div id="mcp-' + scope + '-g-kv" class="mcp-kv-rows"></div>' +
        '</div>' +
      '</div>';
    }

    function renderMcpKvRow() {
      return '<div class="mcp-kv-row">' +
        '<input class="form-input mcp-json" placeholder="KEY" data-kv-key autocomplete="off" />' +
        '<input class="form-input mcp-json" type="password" placeholder="value" data-kv-value autocomplete="off" />' +
        '<button type="button" class="mcp-btn mcp-btn-danger" data-mcp-kv-remove>移除</button>' +
      '</div>';
    }

    function addMcpGuidedRow(scope) {
      const container = document.getElementById('mcp-' + scope + '-g-kv');
      if (container) container.insertAdjacentHTML('beforeend', renderMcpKvRow());
    }

    function updateMcpGuidedTransport(scope) {
      const checked = document.querySelector('input[name="mcp-' + scope + '-g-transport"]:checked');
      const transport = checked ? checked.value : 'stdio';
      const stdioEl = document.getElementById('mcp-' + scope + '-g-stdio');
      const httpEl = document.getElementById('mcp-' + scope + '-g-http');
      const kvLabel = document.getElementById('mcp-' + scope + '-g-kv-label');
      if (stdioEl) stdioEl.style.display = transport === 'stdio' ? '' : 'none';
      if (httpEl) httpEl.style.display = transport === 'http' ? '' : 'none';
      if (kvLabel) kvLabel.textContent = transport === 'stdio' ? '環境變數 (env)' : 'HTTP Headers';
    }

    let pendingMcpCustomScope = null;

    function openMcpCustomDialog(scope) {
      pendingMcpCustomScope = scope;
      const content = document.getElementById('mcp-custom-dialog-content');
      content.innerHTML =
        '<div class="mcp-add-mode">' +
          '<button type="button" class="mcp-mode-btn active" data-mcp-mode="guided">引導式表單</button>' +
          '<button type="button" class="mcp-mode-btn" data-mcp-mode="json">貼上 JSON</button>' +
        '</div>' +
        '<div id="mcp-custom-guided-panel" class="mcp-panel">' + renderMcpGuidedForm('custom') + '</div>' +
        '<div id="mcp-custom-json-panel" class="mcp-panel" style="display:none">' +
          '<p class="mcp-manual-hint">貼上 MCP server 文件給的 <code>mcpServers</code> JSON，原樣保存到這個 scope。remote 走 Streamable HTTP，local 走 stdio。</p>' +
          '<textarea id="mcp-custom-json" class="form-input mcp-json" spellcheck="false" rows="9" placeholder="' + escAttr(MCP_JSON_PLACEHOLDER) + '"></textarea>' +
        '</div>';
      const dialogError = document.getElementById('mcp-custom-dialog-error');
      dialogError.style.display = 'none';
      dialogError.textContent = '';
      addMcpGuidedRow('custom');
      document.getElementById('mcp-custom-dialog').showModal();
    }

    function closeMcpCustomDialog() {
      pendingMcpCustomScope = null;
      document.getElementById('mcp-custom-dialog').close();
    }

    function switchMcpCustomMode(mode) {
      const guidedEl = document.getElementById('mcp-custom-guided-panel');
      const jsonEl = document.getElementById('mcp-custom-json-panel');
      if (guidedEl) guidedEl.style.display = mode === 'guided' ? '' : 'none';
      if (jsonEl) jsonEl.style.display = mode === 'json' ? '' : 'none';
      document.querySelectorAll('#mcp-custom-dialog-content [data-mcp-mode]').forEach((b) => {
        b.classList.toggle('active', b.dataset.mcpMode === mode);
      });
    }

    async function submitMcpCustomDialog(btn) {
      const scope = pendingMcpCustomScope;
      if (!scope) return;
      const dialogError = document.getElementById('mcp-custom-dialog-error');
      dialogError.style.display = 'none';
      dialogError.textContent = '';
      const jsonMode = document.getElementById('mcp-custom-json-panel').style.display !== 'none';
      let json;
      if (jsonMode) {
        const raw = document.getElementById('mcp-custom-json').value.trim();
        if (!raw) { dialogError.textContent = '請貼上 mcpServers JSON'; dialogError.style.display = 'block'; return; }
        json = raw;
      } else {
        const nameEl = document.getElementById('mcp-custom-g-name');
        const name = nameEl ? nameEl.value.trim() : '';
        if (!name) { dialogError.textContent = '請輸入 server 名稱'; dialogError.style.display = 'block'; return; }
        const checked = document.querySelector('input[name="mcp-custom-g-transport"]:checked');
        const transport = checked ? checked.value : 'stdio';
        const kv = {};
        document.querySelectorAll('#mcp-custom-g-kv .mcp-kv-row').forEach((row) => {
          const keyInput = row.querySelector('[data-kv-key]');
          const valueInput = row.querySelector('[data-kv-value]');
          const key = keyInput ? keyInput.value.trim() : '';
          if (key) kv[key] = valueInput ? valueInput.value : '';
        });
        let entry;
        if (transport === 'stdio') {
          const commandEl = document.getElementById('mcp-custom-g-command');
          const command = commandEl ? commandEl.value.trim() : '';
          if (!command) { dialogError.textContent = '請輸入指令'; dialogError.style.display = 'block'; return; }
          const argsEl = document.getElementById('mcp-custom-g-args');
          const argsRaw = argsEl ? argsEl.value.trim() : '';
          const args = argsRaw ? argsRaw.split(',').map((s) => s.trim()).filter(Boolean) : [];
          entry = Object.assign({ command: command }, args.length ? { args: args } : {}, Object.keys(kv).length ? { env: kv } : {});
        } else {
          const urlEl = document.getElementById('mcp-custom-g-url');
          const url = urlEl ? urlEl.value.trim() : '';
          if (!url) { dialogError.textContent = '請輸入 URL'; dialogError.style.display = 'block'; return; }
          entry = Object.assign({ url: url }, Object.keys(kv).length ? { headers: kv } : {});
        }
        json = JSON.stringify({ mcpServers: { [name]: entry } });
      }
      btn.disabled = true;
      btn.textContent = '儲存中…';
      try {
        const data = await apiPost('/admin/api/mcp-servers/mutate', {
          action: 'import', scope: scope, json: json, ...scopeBody(),
        });
        const results = Array.isArray(data.results) ? data.results : [];
        const failed = results.filter((r) => r.error).length;
        closeMcpCustomDialog();
        mcpMessage(scope, failed ? '已儲存，但 ' + failed + ' 個 server 連線失敗，見上方選項維護。' : '已儲存並連線成功。', failed ? 'err' : 'ok');
        await loadMcpServers();
      } catch (err) {
        dialogError.textContent = err.message;
        dialogError.style.display = 'block';
      } finally {
        btn.disabled = false;
        btn.textContent = '新增並測試連線';
      }
    }

    const MCP_JSON_PLACEHOLDER = JSON.stringify({
      mcpServers: {
        browserless: {
          type: 'http',
          url: 'https://mcp.browserless.io/mcp',
          headers: { Authorization: 'Bearer YOUR_API_TOKEN' },
        },
      },
    }, null, 2);

    const loadMcpServers = () => loadScopePanels('mcp', 'mcp-servers', (data, convEl, globalEl) => {
      mcpPresets = Array.isArray(data.presets) ? data.presets : [];
      mcpServersByScope = { conversation: data.conversation || {}, global: data.global || {} };
      if (convEl) renderMcpScope(convEl, 'conversation', mcpServersByScope.conversation);
      if (globalEl) renderMcpScope(globalEl, 'global', mcpServersByScope.global);
    });

    async function mutateMcpServer(scope, action, name, extra) {
      mcpMessage(scope, action === 'test' ? '連線測試中…' : '儲存並測試連線中…', 'busy');
      try {
        const data = await apiPost('/admin/api/mcp-servers/mutate', {
          action: action,
          scope: scope,
          name: name || undefined,
          ...(extra || {}),
          ...scopeBody(),
        });
        const results = Array.isArray(data.results) ? data.results : [];
        const failed = results.filter((r) => r.error).length;
        if (action === 'test') {
          mcpMessage(scope, failed ? '✗ ' + name + ': ' + results[0].error : '✓ ' + name + ': ' + results[0].tools + ' tool(s)', failed ? 'err' : 'ok');
          return;
        }
        if (action === 'remove' || action === 'toggle') {
          mcpMessage(scope, '完成。新設定在下一次回應生效。', 'ok');
        } else {
          mcpMessage(scope, failed ? '已儲存，但 ' + failed + ' 個 server 連線失敗，見下方錯誤。' : '已儲存並連線成功。', failed ? 'err' : 'ok');
        }
        await loadMcpServers();
      } catch (err) {
        mcpMessage(scope, err.message, 'err');
      }
    }

    function openMcpPreset(scope, presetId) {
      const preset = mcpPresets.find((item) => item.id === presetId);
      if (!preset) return;
      pendingMcpInstall = { scope: scope, preset: preset };
      const local = Boolean(preset.server.command);
      const installed = Boolean(mcpServersByScope[scope][preset.serverName]);
      const credentials = preset.credentials.map((credential, index) =>
        '<label class="mcp-credential"><span>' + escHtml(credential.label) + (credential.required ? ' *' : '') + '</span>' +
          '<input data-mcp-credential="' + index + '" type="' + (credential.secret ? 'password' : 'text') + '" autocomplete="off" />' +
          '<small>' + escHtml(credential.description) + '</small></label>'
      ).join('');
      document.getElementById('mcp-dialog-title').textContent = preset.name;
      const dialogError = document.getElementById('mcp-dialog-error');
      dialogError.style.display = 'none';
      dialogError.textContent = '';
      document.getElementById('mcp-dialog-content').innerHTML =
        '<p class="mcp-dialog-desc">' + escHtml(preset.description) + '</p>' +
        '<div class="mcp-install-preview"><span>' + (local ? 'Host command' : 'Remote endpoint') + '</span><code>' + escHtml(mcpTransport(preset.server)) + '</code></div>' +
        '<div class="mcp-security-note ' + (local ? 'local' : 'remote') + '">' +
          (local
            ? '<strong>Host code execution.</strong> This command runs outside the conversation sandbox with the mikan process user permissions.'
            : '<strong>External service.</strong> Tool calls and selected data will be sent to this remote origin.') +
        '</div>' +
        (installed ? '<div class="mcp-replace-note">Installing again replaces the existing <code>' + escHtml(preset.serverName) + '</code> entry in this scope.</div>' : '') +
        (credentials || '<p class="mcp-no-credentials">No credentials required.</p>') +
        '<p class="mcp-secret-note">These values are stored in host-private settings and are not shown to the model or sandbox.</p>' +
        '<a class="mcp-setup-link" href="' + escAttr(preset.setupUrl) + '" target="_blank" rel="noopener">Setup documentation ↗</a>';
      document.getElementById('mcp-install-dialog').showModal();
    }

    function closeMcpInstall() {
      pendingMcpInstall = null;
      document.getElementById('mcp-install-dialog').close();
    }

    async function installMcpPreset(btn) {
      if (!pendingMcpInstall) return;
      const { scope, preset } = pendingMcpInstall;
      const credentials = {};
      document.querySelectorAll('[data-mcp-credential]').forEach((input) => {
        const descriptor = preset.credentials[Number(input.dataset.mcpCredential)];
        if (descriptor) credentials[descriptor.key] = input.value;
      });
      btn.disabled = true;
      btn.textContent = 'Installing…';
      try {
        const data = await apiPost('/admin/api/mcp-servers/mutate', {
          action: 'install', scope: scope, presetId: preset.id, credentials: credentials, ...scopeBody(),
        });
        closeMcpInstall();
        const result = (Array.isArray(data.results) ? data.results : [])[0];
        if (result && result.error) mcpMessage(scope, '✗ ' + preset.name + ' saved but failed to connect: ' + result.error, 'err');
        else mcpMessage(scope, '✓ ' + preset.name + ' installed, ' + (result ? result.tools : 0) + ' tool(s).', 'ok');
        await loadMcpServers();
      } catch (err) {
        const dialogError = document.getElementById('mcp-dialog-error');
        dialogError.textContent = err.message;
        dialogError.style.display = 'block';
      } finally {
        btn.disabled = false;
        btn.textContent = 'Install preset';
      }
    }

    document.addEventListener('click', (event) => {
      const modeBtn = event.target.closest('#mcp-custom-dialog-content [data-mcp-mode]');
      if (modeBtn) { switchMcpCustomMode(modeBtn.dataset.mcpMode); return; }
      const kvAddBtn = event.target.closest('[data-mcp-kv-add]');
      if (kvAddBtn) { addMcpGuidedRow(kvAddBtn.dataset.mcpKvAdd); return; }
      const kvRemoveBtn = event.target.closest('[data-mcp-kv-remove]');
      if (kvRemoveBtn) { kvRemoveBtn.closest('.mcp-kv-row').remove(); return; }
      const transportRadio = event.target.closest('input[name^="mcp-"][name$="-g-transport"]');
      if (transportRadio) {
        const match = /^mcp-(.+)-g-transport$/.exec(transportRadio.name);
        if (match) updateMcpGuidedTransport(match[1]);
        return;
      }
      const btn = event.target.closest('[data-mcp-action]');
      if (!btn) return;
      if (btn.dataset.mcpAction === 'open-custom') { openMcpCustomDialog(btn.dataset.mcpScope); return; }
      if (btn.dataset.mcpAction === 'preset') { openMcpPreset(btn.dataset.mcpScope, btn.dataset.mcpPreset); return; }
      void mutateMcpServer(btn.dataset.mcpScope, btn.dataset.mcpAction, btn.dataset.mcpName);
    });

    let skillsCache = [];

    function renderSkillsInto(containerId, skills, allowedSource) {
      const container = document.getElementById(containerId);
      if (!container) return;
      const filtered = allowedSource ? skills.filter((s) => s.source === allowedSource) : skills;
      if (filtered.length === 0) {
        container.innerHTML = '<div class="empty-state">No skills available</div>';
        return;
      }
      container.innerHTML = '<div class="skills-list">' +
        filtered.map((s) =>
          '<div class="skill-row">' +
            '<button class="skill-row-btn" data-skill-source="' + escAttr(s.source) + '" data-skill-directory="' + escAttr(s.directory) + '" data-skill-name="' + escAttr(s.name) + '">' +
              '<div class="skill-name">' + escHtml(s.name) + '<span class="skill-source skill-source-' + s.source + '">' + s.source + '</span></div>' +
              (s.description ? '<div class="skill-desc">' + escHtml(s.description) + '</div>' : '') +
            '</button>' +
            '<div class="skill-row-actions">' +
              '<button class="mcp-btn" data-skill-edit-source="' + escAttr(s.source) + '" data-skill-edit-directory="' + escAttr(s.directory) + '">Edit</button>' +
              '<button class="mcp-btn mcp-btn-danger" data-skill-delete-source="' + escAttr(s.source) + '" data-skill-delete-directory="' + escAttr(s.directory) + '" data-skill-delete-name="' + escAttr(s.name) + '">Delete</button>' +
            '</div>' +
          '</div>'
        ).join('') + '</div>';
    }

    async function loadSkills() {
      const container = document.getElementById('skills-content');
      const previewEl = document.getElementById('skills-preview');
      container.innerHTML = '<div class="loading-msg">Loading…</div>';
      if (previewEl) previewEl.innerHTML = '<div class="placeholder-msg">Click a skill to preview SKILL.md</div>';
      try {
        const data = await apiGet('/admin/api/skills?' + scopeQuery());
        skillsCache = Array.isArray(data.skills) ? data.skills : [];
        renderSkillsInto('skills-content', skillsCache);
        renderSkillsInto('global-skills-content', skillsCache, 'global');
      } catch (err) {
        container.innerHTML = '<div class="err-msg">' + escHtml(err.message) + '</div>';
      }
    }

    const loadGlobalSkills = loadSkills;

    async function previewSkillInto(previewId, source, directory, name) {
      const previewEl = document.getElementById(previewId);
      if (!previewEl) return;
      if (!source || !directory) {
        previewEl.innerHTML = '<div class="err-msg">Missing skill source or directory</div>';
        return;
      }
      previewEl.innerHTML = '<div class="loading-msg">Loading ' + escHtml(name || directory) + '…</div>';
      try {
        const data = await apiGet('/admin/api/skills/file?' + scopeQuery() + '&source=' + encodeURIComponent(source) + '&directory=' + encodeURIComponent(directory));
        renderPreviewFileResult(previewEl, source + '/' + directory + '/SKILL.md', data);
      } catch (err) {
        previewEl.innerHTML = '<div class="err-msg">' + escHtml(err.message) + '</div>';
      }
    }

    async function deleteSkill(source, directory, name) {
      if (!confirm('Delete skill "' + (name || directory) + '" (' + source + ')?')) return;
      try {
        await apiPost('/admin/api/skills/mutate', { action: 'delete', source: source, directory: directory, ...scopeBody() });
        await loadSkills();
      } catch (err) {
        alert(err.message);
      }
    }

    function bindSkillListEvents(containerId, previewId) {
      const el = document.getElementById(containerId);
      if (!el) return;
      el.addEventListener('click', (event) => {
        const previewBtn = event.target.closest('[data-skill-source]');
        if (previewBtn) {
          previewSkillInto(previewId, previewBtn.dataset.skillSource, previewBtn.dataset.skillDirectory, previewBtn.dataset.skillName);
          return;
        }
        const editBtn = event.target.closest('[data-skill-edit-source]');
        if (editBtn) {
          const skill = skillsCache.find((s) => s.source === editBtn.dataset.skillEditSource && s.directory === editBtn.dataset.skillEditDirectory);
          if (skill) void openSkillDialog(skill.source, skill);
          return;
        }
        const deleteBtn = event.target.closest('[data-skill-delete-source]');
        if (deleteBtn) {
          void deleteSkill(deleteBtn.dataset.skillDeleteSource, deleteBtn.dataset.skillDeleteDirectory, deleteBtn.dataset.skillDeleteName);
        }
      });
    }
    bindSkillListEvents('skills-content', 'skills-preview');
    bindSkillListEvents('global-skills-content', 'global-skills-preview');

    let editingSkill = null;
    let pendingSkillScope = null;

    async function openSkillDialog(scope, existing) {
      editingSkill = existing ? { source: existing.source, directory: existing.directory } : null;
      document.getElementById('skill-dialog-eyebrow').textContent = scope === 'global' ? 'Global skill' : 'Conversation skill';
      document.getElementById('skill-dialog-title').textContent = existing ? 'Edit skill' : 'New skill';
      const dirInput = document.getElementById('skill-dialog-directory');
      dirInput.value = existing ? existing.directory : '';
      dirInput.disabled = Boolean(existing);
      document.getElementById('skill-dialog-name').value = existing ? existing.name : '';
      document.getElementById('skill-dialog-description').value = existing ? existing.description : '';
      const contentEl = document.getElementById('skill-dialog-content');
      contentEl.value = '';
      const dialogError = document.getElementById('skill-dialog-error');
      dialogError.style.display = 'none';
      dialogError.textContent = '';
      pendingSkillScope = scope;
      if (existing) {
        contentEl.value = 'Loading…';
        try {
          const data = await apiGet('/admin/api/skills/file?' + scopeQuery() + '&source=' + encodeURIComponent(existing.source) + '&directory=' + encodeURIComponent(existing.directory));
          contentEl.value = data.binary ? '' : (data.content || '').replace(/^---[\\s\\S]*?---\\n?/, '').trim();
        } catch (err) {
          contentEl.value = '';
          dialogError.textContent = 'Failed to load current content: ' + err.message;
          dialogError.style.display = 'block';
        }
      }
      document.getElementById('skill-dialog').showModal();
    }

    function closeSkillDialog() {
      editingSkill = null;
      pendingSkillScope = null;
      document.getElementById('skill-dialog').close();
    }

    async function submitSkillDialog(btn) {
      const dialogError = document.getElementById('skill-dialog-error');
      dialogError.style.display = 'none';
      dialogError.textContent = '';
      const directory = document.getElementById('skill-dialog-directory').value.trim();
      const name = document.getElementById('skill-dialog-name').value.trim() || directory;
      const description = document.getElementById('skill-dialog-description').value.trim();
      const content = document.getElementById('skill-dialog-content').value;
      if (!directory) { dialogError.textContent = 'Directory is required'; dialogError.style.display = 'block'; return; }
      if (!description) { dialogError.textContent = 'Description is required'; dialogError.style.display = 'block'; return; }
      const source = editingSkill ? editingSkill.source : pendingSkillScope;
      btn.disabled = true;
      btn.textContent = 'Saving…';
      try {
        await apiPost('/admin/api/skills/mutate', {
          action: 'save', source: source, directory: directory, name: name, description: description, content: content, ...scopeBody(),
        });
        closeSkillDialog();
        await loadSkills();
      } catch (err) {
        dialogError.textContent = err.message;
        dialogError.style.display = 'block';
      } finally {
        btn.disabled = false;
        btn.textContent = 'Save';
      }
    }


    const openLogin = (silent) => openPortalLink('vault', 'login', silent);
    const openSessionView = (silent) => openPortalLink('session', 'session', silent);

    async function openPortalLink(resultId, kind, silent) {
      const result = document.getElementById(resultId + '-link-result');
      if (silent) { result.style.display = 'none'; return; }
      result.style.display = 'block'; result.className = 'link-result loading'; result.textContent = 'Generating link…';
      try {
        const data = await apiPost('/admin/api/conversations/' + kind + '-link', scopeBody());
        result.className = 'link-result ok';
        result.innerHTML =
          (kind === 'login' ? '<span class="link-vault">vault: <code>' + escHtml(data.vaultId) + '</code></span>' : '') +
          '<a href="' + escAttr(data.url) + '" target="_blank" rel="noopener">' + escHtml(data.url) + '</a>' +
          '<button class="copy-link-btn" data-admin-action="copy-link" data-copy-text="' + escAttr(data.url) + '">Copy</button>';
        window.open(data.url, '_blank', 'noopener');
      } catch (err) {
        result.className = 'link-result err'; result.textContent = err.message;
      }
    }


    const loadConversationEvents = () => loadEventList(true);
    const loadEvents = () => loadEventList(false);

    async function loadEventList(conversation) {
      const container = document.getElementById(conversation ? 'events-content' : 'global-events-content');
      if (!container) return;
      container.innerHTML = '<div class="loading-msg">Loading…</div>';
      try {
        const data = await apiGet(conversation ? '/admin/api/conversations/events?' + scopeQuery() : '/admin/api/events');
        if (data.events.length === 0) {
          container.innerHTML = '<div class="empty-state">' + (conversation ? '沒有關聯此對話的 event' : 'No events scheduled') + '</div>';
          return;
        }
        container.innerHTML = '<div class="events-list">' +
          data.events.map((e) => renderEventRow(e, conversation)).join('') + '</div>';
      } catch (err) {
        container.innerHTML = '<div class="err-msg">' + escHtml(err.message) + '</div>';
      }
    }

    function renderEventRow(e, allowDelete) {
      const meta = [e.type, e.platform, e.conversationId, e.schedule || e.at]
        .filter(Boolean).map(escHtml).join(' · ');
      const preview = e.text ? '<div class="event-text">' + escHtml(e.text.length > 240 ? e.text.slice(0, 237) + '…' : e.text) + '</div>' : '';
      const deleteBtn = allowDelete
        ? '<button class="event-delete-btn" data-admin-action="delete-event" data-event-name="' + escAttr(e.name) + '">Delete</button>'
        : '';
      return '<div class="event-row">' +
        '<div class="event-row-top">' +
          '<div class="event-name"><code>' + escHtml(e.name) + '</code></div>' +
          deleteBtn +
        '</div>' +
        '<div class="event-meta">' + meta + '</div>' +
        preview +
      '</div>';
    }

    async function deleteEvent(name, btn) {
      if (!confirm('Delete event "' + name + '"?')) return;
      btn.disabled = true; btn.textContent = 'Deleting…';
      try {
        await apiPost('/admin/api/conversations/events/delete', {
          ...scopeBody(), name,
        });
        await loadConversationEvents();
      } catch (err) {
        btn.disabled = false; btn.textContent = 'Delete';
        alert(err.message);
      }
    }


    function initGlobal() {}

    async function loadAllConversations() {
      const container = document.getElementById('all-conv-content');
      container.innerHTML = '<div class="loading-msg">Loading…</div>';
      try {
        const data = await apiGet('/admin/api/conversations');
        if (data.conversations.length === 0) {
          container.innerHTML = '<div class="empty-state">No conversations found</div>';
          return;
        }
        container.innerHTML = '<div class="conv-list">' + data.conversations.map((c) => {
          const last = c.lastActivityAt ? new Date(c.lastActivityAt).toLocaleString() : '—';
          return '<button class="conv-row-btn" data-admin-action="select-conversation" data-conversation-id="' + escAttr(c.conversationId) + '">' +
            '<span class="conv-id">' + escHtml(c.label || c.conversationId) + '</span>' +
            (c.running ? '<span class="status-pill running">running</span>' : '') +
            '<span class="conv-last">' + escHtml(last) + '</span>' +
          '</button>';
        }).join('') + '</div>';
      } catch (err) {
        container.innerHTML = '<div class="err-msg">' + escHtml(err.message) + '</div>';
      }
    }

    async function loadSessionUsage() {
      const container = document.getElementById('session-usage-content');
      container.innerHTML = '<div class="loading-msg">Loading…</div>';
      try {
        const data = await apiGet('/admin/api/session-usage');
        if (data.sessions.length === 0) {
          container.innerHTML = '<div class="empty-state">No token usage found</div>';
          return;
        }
        container.innerHTML = '<div class="usage-table-wrap"><table class="usage-table"><thead><tr><th>#</th><th>Channel</th><th>Session</th><th>Updated</th><th>Input</th><th>Output</th><th>Cache Read</th><th>Cache Write</th><th>Total</th><th>Cost</th></tr></thead><tbody>' +
          data.sessions.map((s, i) => '<tr>' +
            '<td>' + (i + 1) + '</td>' +
            '<td>' + escHtml(s.label || s.conversationId) + '</td>' +
            '<td><code>' + escHtml(s.fileName) + '</code></td>' +
            '<td>' + escHtml(new Date(s.updatedAt).toLocaleString()) + '</td>' +
            '<td>' + fmtNum(s.input) + '</td>' +
            '<td>' + fmtNum(s.output) + '</td>' +
            '<td>' + fmtNum(s.cacheRead) + '</td>' +
            '<td>' + fmtNum(s.cacheWrite) + '</td>' +
            '<td><strong>' + fmtNum(s.total) + '</strong></td>' +
            '<td>' + (s.cost > 0 ? '$' + Number(s.cost).toFixed(4) : '—') + '</td>' +
          '</tr>').join('') + '</tbody></table></div>';
      } catch (err) {
        container.innerHTML = '<div class="err-msg">' + escHtml(err.message) + '</div>';
      }
    }

    function fmtNum(value) {
      return Number(value || 0).toLocaleString('en-US');
    }

    let timelineConvLoaded = false;
    let timelineData = null;
    let timelineFilter = null;
    async function ensureTimelineConvOptions() {
      if (timelineConvLoaded) return;
      const sel = document.getElementById('timeline-conv');
      const prev = sel.value;
      const data = await apiGet('/admin/api/conversations');
      if (!data.conversations.length) {
        sel.innerHTML = '<option value="">No conversations</option>';
        timelineConvLoaded = true;
        return;
      }
      const want = prev || defaultConversationKey;
      sel.innerHTML = data.conversations.map((c) => {
        const key = c.platform + ':' + c.conversationId;
        return '<option value="' + escAttr(key) + '"' +
          (key === want ? ' selected' : '') + '>' +
          escHtml(c.label || c.conversationId) + '</option>';
      }).join('');
      timelineConvLoaded = true;
    }

    async function loadTokenUsage() {
      loadSessionUsage();
      timelineConvLoaded = false;
      await loadUsageTimeline();
    }

    async function loadUsageTimeline() {
      const container = document.getElementById('usage-timeline-content');
      try {
        await ensureTimelineConvOptions();
        const conv = document.getElementById('timeline-conv').value;
        if (!conv) {
          container.innerHTML = '<div class="empty-state">No conversations found</div>';
          return;
        }
        container.innerHTML = '<div class="loading-msg">Loading…</div>';
        const convScope = scopeOf(conv);
        const data = await apiGet('/admin/api/conversation-usage?conversationId=' +
          encodeURIComponent(convScope.conversationId) +
          '&platform=' + encodeURIComponent(convScope.platform));
        timelineData = data;
        container.innerHTML = renderUsageTimeline(data);
      } catch (err) {
        container.innerHTML = '<div class="err-msg">' + escHtml(err.message) + '</div>';
      }
    }

    function tlCard(label, value) {
      return '<div class="tl-card"><div class="tl-card-label">' + label +
        '</div><div class="tl-card-value">' + value + '</div></div>';
    }

    const TL_SERIES = [
      { key: 'cacheRead', seg: 'tl-cache-read', sw: 'sw-cache-read', label: 'Cache read' },
      { key: 'cacheWrite', seg: 'tl-cache-write', sw: 'sw-cache-write', label: 'Cache write' },
      { key: 'input', seg: 'tl-input', sw: 'sw-input', label: 'Input' },
      { key: 'output', seg: 'tl-output', sw: 'sw-output', label: 'Output' },
    ];

    function toggleTimelineFilter(key) {
      timelineFilter = timelineFilter === key ? null : key;
      if (timelineData) {
        document.getElementById('usage-timeline-content').innerHTML = renderUsageTimeline(timelineData);
      }
    }

    function renderUsageTimeline(data) {
      const buckets = data.buckets || [];
      const totals = data.totals || { total: 0, cost: 0, cacheRead: 0 };
      const cacheHit = totals.total > 0 ? Math.round((totals.cacheRead / totals.total) * 100) : 0;
      const cards = '<div class="tl-cards">' +
        tlCard('Total cost', totals.cost > 0 ? '$' + Number(totals.cost).toFixed(4) : '—') +
        tlCard('Total tokens', fmtNum(totals.total)) +
        tlCard('Cache hit', cacheHit + '%') +
      '</div>';

      if (totals.total === 0) {
        const emptyNote = data.hasOlder
          ? '<div class="tl-note">No usage in the last 14 days · earlier activity exists</div>'
          : '<div class="empty-state">No token usage in the last 14 days</div>';
        return cards + emptyNote;
      }

      const active = TL_SERIES.find((s) => s.key === timelineFilter) || null;
      const valueOf = (b) => active ? (b[active.key] || 0) : b.total;
      const max = Math.max(1, ...buckets.map(valueOf));
      const px = (v) => Math.round((v / max) * 180);

      const legend = '<div class="tl-legend">' + TL_SERIES.map((s) => {
        const cls = 'tl-legend-item' +
          (active && active.key === s.key ? ' active' : (active ? ' dim' : ''));
        return '<span class="' + cls + '" data-admin-action="toggle-timeline-filter" data-filter-key="' + escAttr(s.key) + '">' +
          '<i class="sw ' + s.sw + '"></i>' + s.label + '</span>';
      }).join('') + '</div>';

      const bars = buckets.map((b) => {
        const val = valueOf(b);
        const tip = active
          ? b.date + ' · ' + active.label + ': ' + fmtNum(b[active.key] || 0) + ' tokens'
          : b.date + ' · ' + fmtNum(b.total) + ' tokens' +
            (b.cost > 0 ? ' · $' + Number(b.cost).toFixed(4) : '');
        let inner;
        if (val <= 0) {
          inner = '<span class="tl-empty"></span>';
        } else if (active) {
          inner = '<span class="tl-seg ' + active.seg + '" style="height:' + px(val) + 'px"></span>';
        } else {
          inner = '<span class="tl-seg tl-output" style="height:' + px(b.output) + 'px"></span>' +
            '<span class="tl-seg tl-input" style="height:' + px(b.input) + 'px"></span>' +
            '<span class="tl-seg tl-cache-write" style="height:' + px(b.cacheWrite) + 'px"></span>' +
            '<span class="tl-seg tl-cache-read" style="height:' + px(b.cacheRead) + 'px"></span>';
        }
        return '<div class="tl-bar">' +
          '<span class="tl-tip">' + escHtml(tip) + '</span>' +
          '<div class="tl-fill">' + inner + '</div>' +
        '</div>';
      }).join('');

      const axis = buckets.length
        ? '<div class="tl-axis"><span>' + escHtml(buckets[0].date.slice(5)) +
          '</span><span>' + escHtml(buckets[buckets.length - 1].date.slice(5)) + '</span></div>'
        : '';
      const note = data.hasOlder
        ? '<div class="tl-note">Showing last 14 days · earlier activity not shown</div>'
        : '<div class="tl-note">Showing last 14 days</div>';
      const peak = '<div class="tl-peak" style="bottom:180px"><span class="tl-peak-label">' +
        fmtNum(max) + ' tokens</span></div>';
      return cards + legend + '<div class="tl-chart">' + peak + bars + '</div>' + axis + note;
    }

    function renderGlobalSettings(data) {
      const thinkingOpts = renderThinkingOptions(data.thinkingLevel);
      const replyModeOpts = renderReplyOptions(data.slack);
      return [
        '<div class="config-grid">',
          renderConfigCard('Default model', [
            '<div class="config-row config-row-stack"><label>Model</label><select id="g-model-ref">' + renderModelOptions(data.provider, data.model) + '</select></div>',
            '<div class="config-row"><label>Thinking</label><select id="g-thinking">' + thinkingOpts + '</select></div>',
          ].join(''), 'saveGlobalModel', 'Save model', 'g-model-result'),
          renderConfigCard('Sandbox limits', [
            '<div class="config-row"><label>CPUs</label><input id="g-cpus" placeholder="0.5" value="' + escAttr(data.sandboxCpus || '') + '"></div>',
            '<div class="config-row"><label>Memory</label><input id="g-mem" placeholder="1g" value="' + escAttr(data.sandboxMemory || '') + '"></div>',
            '<div class="config-row"><label>Boost CPUs</label><input id="g-bcpus" placeholder="2" value="' + escAttr(data.sandboxBoostCpus || '') + '"></div>',
            '<div class="config-row"><label>Boost Mem</label><input id="g-bmem" placeholder="4g" value="' + escAttr(data.sandboxBoostMemory || '') + '"></div>',
          ].join(''), 'saveGlobalSandbox', 'Save sandbox', 'g-sandbox-result'),
          renderConfigCard('Slack', [
            '<div class="config-row"><label>Reply mode</label><select id="g-slack-reply-mode">' + replyModeOpts + '</select></div>',
          ].join(''), 'saveGlobalSlack', 'Save Slack', 'g-slack-result'),
        '</div>',
      ].join('');
    }

    async function saveGlobalModel(btn) {
      const selectedModel = parseModelRef(document.getElementById('g-model-ref').value.trim());
      const provider = selectedModel.provider;
      const model = selectedModel.model;
      const thinkingLevel = document.getElementById('g-thinking').value;
      const result = document.getElementById('g-model-result');
      if (!provider || !model) {
        result.style.display = 'block'; result.className = 'inline-result err';
        result.textContent = 'Provider and model are required'; return;
      }
      btn.disabled = true; btn.textContent = 'Saving…'; result.style.display = 'none';
      try {
        await apiPost('/admin/api/settings/model', { provider, model, thinkingLevel });
        result.style.display = 'block'; result.className = 'inline-result ok'; result.textContent = 'Saved ✓';
      } catch (err) {
        result.style.display = 'block'; result.className = 'inline-result err'; result.textContent = err.message;
      } finally {
        btn.disabled = false; btn.textContent = 'Save model';
      }
    }

    async function saveGlobalSandbox(btn) {
      const cpus = document.getElementById('g-cpus').value.trim();
      const memory = document.getElementById('g-mem').value.trim();
      const boostCpus = document.getElementById('g-bcpus').value.trim();
      const boostMemory = document.getElementById('g-bmem').value.trim();
      const result = document.getElementById('g-sandbox-result');
      await saveSetting(btn, result, 'settings/sandbox', { cpus, memory, boostCpus, boostMemory }, 'Save sandbox');
    }

    async function saveGlobalSlack(btn) {
      const replyMode = document.getElementById('g-slack-reply-mode').value;
      const result = document.getElementById('g-slack-result');
      await saveSetting(btn, result, 'settings/slack', { replyMode }, 'Save Slack');
    }

  `;

export const adminViewStartupScript = `    initConvSwitcher();
    initRailNav();
  `;

export const adminViewStyles = `

  .shell { max-width: 1180px; }



  .settings-shell {
    display: grid;
    grid-template-columns: 216px 1fr;
    align-items: start;
    gap: 22px;
  }

  .settings-rail {
    position: sticky;
    top: 28px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .rail-scope {
    display: flex;
    padding: 3px;
    border: 1px solid var(--border);
    border-radius: 11px;
    background: rgba(0,0,0,0.03);
    gap: 2px;
  }
  .rail-scope-btn {
    flex: 1;
    padding: 7px 8px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: var(--muted);
    font: 600 0.72rem/1.2 'DM Sans', sans-serif;
    letter-spacing: 0.01em;
    cursor: pointer;
    transition: background 140ms, color 140ms;
  }
  .rail-scope-btn:hover { color: var(--text); }
  .rail-scope-btn.active { background: var(--surface); color: var(--text); box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .rail-scope-btn:focus-visible { outline: 2px solid var(--text); outline-offset: 2px; }

  .rail-nav { display: flex; flex-direction: column; gap: 1px; }
  .rail-nav[hidden] { display: none; }
  .rail-link {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 10px; border: none; border-radius: 9px;
    background: transparent; color: var(--muted); text-align: left;
    font: 500 0.86rem/1.2 'DM Sans', sans-serif; cursor: pointer;
    transition: background 120ms, color 120ms;
  }
  .rail-link svg { flex-shrink: 0; opacity: 0.75; }
  .rail-link:hover { background: rgba(0,0,0,0.045); color: var(--text); }
  .rail-link:hover svg { opacity: 1; }
  .rail-link.active {
    background: var(--text); color: #fafafa; font-weight: 600;
  }
  .rail-link.active svg { opacity: 1; }
  .rail-link:focus-visible { outline: 2px solid var(--text); outline-offset: 1px; }

  .settings-panels { min-width: 0; }
  .tab-panel { display: none; flex-direction: column; gap: 0; }
  .tab-panel.active { display: flex; }



  .pane { display: none; padding: 30px 0; border-bottom: 1px solid var(--border); }
  .pane:last-child { border-bottom: none; }
  .pane.active { display: block; animation: pane-in 180ms ease; }
  @keyframes pane-in { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }

  .pane-head {
    display: flex; align-items: flex-start; justify-content: space-between;
    gap: 16px; margin-bottom: 22px; flex-wrap: wrap;
  }
  .pane-title {
    font-family: 'Lora', Georgia, serif; font-size: 1.32rem; font-weight: 600;
    letter-spacing: -0.01em; line-height: 1.25; margin-bottom: 5px;
  }
  .pane-desc { color: var(--muted); font-size: 0.88rem; line-height: 1.55; max-width: 52ch; }
  .pane-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
  .pane-body { display: flex; flex-direction: column; gap: 14px; }

  .card-desc { color: var(--muted); font-size: 0.9rem; line-height: 1.55; margin-bottom: 12px; }

  .link-result {
    margin-top: 12px; padding: 10px 14px; border-radius: 10px;
    display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
    font-size: 0.84rem;
  }
  .link-result.ok { background: var(--ok-bg); border: 1px solid var(--ok-border); }
  .link-result.err { background: var(--err-bg); border: 1px solid var(--err-border); color: var(--err-text); }
  .link-result.loading { background: rgba(0,0,0,0.025); border: 1px solid var(--border); color: var(--muted); }
  .link-result a {
    color: var(--ok-text);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 0.78rem; word-break: break-all; flex: 1; min-width: 0;
  }
  .link-vault { color: var(--muted); font-size: 0.78rem; flex-shrink: 0; }
  .copy-link-btn {
    padding: 5px 12px; border: 1px solid var(--ok-border); border-radius: 7px;
    background: rgba(255,255,255,0.7); color: var(--ok-text);
    font: 500 0.78rem/1.2 'DM Sans', sans-serif;
    cursor: pointer; flex-shrink: 0;
  }

  .config-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 18px;
  }
  .config-block { display: flex; flex-direction: column; gap: 10px; }

  .config-block .primary-action-btn { align-self: flex-start; min-width: 132px; justify-content: center; }
  .config-row { display: grid; grid-template-columns: 110px 1fr; gap: 10px; align-items: center; }
  .config-row.config-row-stack { grid-template-columns: 1fr; }
  .config-row label { font-size: 0.82rem; color: var(--muted); }
  .config-row input, .config-row select, .config-row textarea {
    padding: 7px 10px; border: 1px solid var(--border); border-radius: 8px;
    font-family: inherit; font-size: 0.84rem; width: 100%;
  }
  .config-row textarea {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    resize: vertical;
  }
  .toggle { display: inline-flex; align-items: center; gap: 8px; font-size: 0.84rem; }

  .inline-result {
    padding: 8px 12px; border-radius: 8px; font-size: 0.82rem; margin-top: 4px;
  }
  .inline-result.ok { background: var(--ok-bg); color: var(--ok-text); border: 1px solid var(--ok-border); }
  .inline-result.err { background: var(--err-bg); color: var(--err-text); border: 1px solid var(--err-border); }

  .refresh-btn {
    flex-shrink: 0; padding: 6px 12px;
    border: 1px solid var(--border); border-radius: 10px;
    background: rgba(0,0,0,0.025); color: var(--muted);
    font: 500 0.8rem/1.2 'DM Sans', sans-serif; cursor: pointer;
    transition: background 120ms, color 120ms;
  }
  .refresh-btn:hover { background: rgba(0,0,0,0.06); color: var(--text); }



  .workspace-split {
    display: grid; grid-template-columns: 260px 1fr; gap: 14px;
    min-height: 360px;
  }
  .workspace-tree {
    border: 1px solid var(--border); border-radius: 12px; padding: 10px;
    background: rgba(0,0,0,0.02); overflow: auto; max-height: 480px;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 0.78rem;
  }
  .workspace-tree ul { list-style: none; padding-left: 12px; margin: 0; }
  .workspace-tree .tree-root { padding-left: 0; }
  .workspace-tree details { margin: 1px 0; }
  .workspace-tree summary { cursor: pointer; padding: 2px 4px; border-radius: 4px; }
  .workspace-tree summary:hover { background: rgba(0,0,0,0.05); }
  .tree-dir { color: var(--text); font-weight: 600; }
  .tree-dir.empty { color: var(--subtle); font-weight: 400; }
  .tree-file {
    display: block; width: 100%; text-align: left;
    background: transparent; border: none; cursor: pointer;
    padding: 2px 4px; border-radius: 4px;
    font-family: inherit; font-size: inherit; color: var(--muted);
  }
  .tree-file:hover { background: rgba(0,0,0,0.05); color: var(--text); }

  .workspace-preview {
    border: 1px solid var(--border); border-radius: 12px;
    background: #fff; padding: 12px; overflow: auto; max-height: 480px;
  }
  .preview-meta {
    font-size: 0.74rem; color: var(--subtle);
    margin-bottom: 8px; padding-bottom: 8px; border-bottom: 1px solid var(--border);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
  }
  .preview-body {
    margin: 0; white-space: pre-wrap; word-break: break-word;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 0.78rem; color: var(--text);
  }
  .placeholder-msg { color: var(--subtle); font-size: 0.86rem; padding: 24px 8px; text-align: center; }



  .skills-list { display: flex; flex-direction: column; gap: 8px; }
  .skill-row {
    padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px;
    background: rgba(0,0,0,0.02);
    display: flex; flex-direction: column; align-items: stretch; gap: 6px;
  }
  .skill-row-btn {
    flex: 1 1 auto; min-width: 0; text-align: left; cursor: pointer; font-family: inherit;
    background: transparent; border: none; padding: 0;
  }
  .skill-row-btn:hover .skill-name { color: var(--accent); }
  .skill-row-actions { display: flex; gap: 6px; flex-shrink: 0; justify-content: flex-end; }
  .skill-name {
    font-weight: 650; font-size: 0.9rem; color: var(--text);
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  }
  .skill-source {
    padding: 1px 8px; border-radius: 999px; font-size: 0.7rem;
    font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
  }
  .skill-source-global { background: rgba(59,130,246,0.1); color: #1d4ed8; }
  .skill-source-conversation { background: rgba(217,119,6,0.1); color: var(--accent); }
  .skill-desc { color: var(--muted); font-size: 0.82rem; margin-top: 4px; line-height: 1.5; }



  .form-input {
    flex: 1 1 240px; min-width: 0; padding: 8px 10px;
    border: 1px solid var(--border); border-radius: 8px; background: var(--card);
    font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.8rem; color: var(--text);
  }
  .status-msg {
    padding: 8px 12px; border-radius: 8px; margin-bottom: 12px;
    font-size: 0.82rem; line-height: 1.5; word-break: break-word;
  }
  .status-msg-ok { background: rgba(22,163,74,0.1); color: #15803d; }
  .status-msg-err { background: rgba(220,38,38,0.1); color: #b91c1c; }
  .status-msg-busy { background: rgba(0,0,0,0.05); color: var(--muted); }
  .mcp-btn {
    padding: 4px 10px; border: 1px solid var(--border); border-radius: 7px;
    background: var(--card); color: var(--text); font-size: 0.76rem; cursor: pointer;
  }
  .mcp-btn:hover { background: rgba(0,0,0,0.05); }
  .mcp-btn-danger { color: #b91c1c; }
  .mcp-badge {
    padding: 1px 8px; border-radius: 999px; font-size: 0.7rem;
    font-weight: 600; letter-spacing: 0.03em;
  }
  .mcp-badge-ok { background: rgba(22,163,74,0.1); color: #15803d; }
  .mcp-badge-warn { background: rgba(217,119,6,0.12); color: var(--accent); }

  .mcp-market-head {
    display: flex; align-items: end; justify-content: space-between; gap: 16px;
    margin-bottom: 12px;
  }
  .mcp-market-head h3 { margin: 0; font-size: 1rem; }
  .mcp-market-head p { margin: 3px 0 0; color: var(--muted); font-size: 0.8rem; }
  .mcp-market-head > span {
    color: var(--subtle); font: 500 0.72rem/1.2 'JetBrains Mono', ui-monospace, monospace;
  }
  .mcp-preset-grid {
    display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px;
  }
  .mcp-preset {
    min-width: 0; padding: 14px; border: 1px solid var(--border); border-radius: 12px;
    background:
      linear-gradient(145deg, rgba(255,255,255,0.85), rgba(247,245,238,0.72)),
      var(--card);
    display: flex; flex-direction: column; min-height: 190px;
  }
  .mcp-preset-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .mcp-preset-category {
    color: var(--accent); font-size: 0.66rem; font-weight: 700;
    letter-spacing: 0.09em; text-transform: uppercase;
  }
  .mcp-preset h3 { margin: 14px 0 5px; font-size: 1.06rem; letter-spacing: -0.02em; }
  .mcp-preset p { margin: 0; color: var(--muted); font-size: 0.8rem; line-height: 1.5; }
  .mcp-preset-meta {
    margin-top: 12px; color: var(--subtle); font-size: 0.72rem;
  }
  .mcp-preset-meta code { color: var(--text); background: transparent; }
  .mcp-preset-actions {
    margin-top: auto; padding-top: 16px; display: flex; align-items: center;
    justify-content: space-between; gap: 10px;
  }
  .mcp-preset-actions a, .mcp-setup-link {
    color: var(--muted); font-size: 0.76rem; text-decoration: none;
  }
  .mcp-preset-actions a:hover, .mcp-setup-link:hover { color: var(--text); text-decoration: underline; }
  .mcp-preset-actions .primary-action-btn { padding: 6px 12px; }
  .mcp-installed {
    margin-top: 14px; border-top: 1px solid var(--border); padding-top: 12px;
  }
  .mcp-installed > summary {
    cursor: pointer; color: var(--muted); font-size: 0.8rem; font-weight: 600;
    margin-bottom: 10px;
  }
  .mcp-installed-card { min-height: 150px; }
  .mcp-installed-transport {
    font-family: 'JetBrains Mono', ui-monospace, monospace; word-break: break-all;
  }
  .mcp-add-card {
    min-width: 0; min-height: 190px; border: 1.5px dashed var(--border); border-radius: 12px;
    background: transparent; color: var(--muted); font-size: 0.86rem; font-weight: 600;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 8px; cursor: pointer;
  }
  .mcp-add-card:hover { background: rgba(0,0,0,0.03); color: var(--text); border-color: var(--text); }
  .mcp-add-card-plus { font-size: 1.8rem; line-height: 1; font-weight: 400; }
  .mcp-manual-hint { color: var(--muted); font-size: 0.8rem; margin: 0 0 10px; line-height: 1.5; }
  .mcp-add-mode { display: flex; gap: 8px; margin: 0 0 12px; }
  .mcp-mode-btn {
    padding: 6px 12px; border: 1px solid var(--border); border-radius: 999px;
    background: var(--card); font-size: 0.8rem; cursor: pointer; color: var(--muted);
  }
  .mcp-mode-btn.active { background: var(--text); color: #fafafa; border-color: var(--text); }
  .mcp-guided-grid { display: grid; gap: 12px; }
  .mcp-field { display: grid; gap: 5px; }
  .mcp-field span { font-size: 0.78rem; font-weight: 650; color: var(--muted); }
  .mcp-transport-toggle { display: flex; gap: 16px; font-size: 0.85rem; align-items: center; }
  .mcp-transport-toggle label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
  .mcp-transport-fields { display: grid; gap: 12px; }
  .mcp-kv-block { display: grid; gap: 8px; }
  .mcp-kv-head { display: flex; align-items: center; justify-content: space-between; }
  .mcp-kv-head span { font-size: 0.78rem; font-weight: 650; color: var(--muted); }
  .mcp-kv-rows { display: grid; gap: 6px; }
  .mcp-kv-row { display: flex; gap: 8px; }
  .mcp-kv-row .form-input { flex: 1 1 auto; }
  .mcp-json {
    width: 100%; box-sizing: border-box; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.8rem; line-height: 1.45; resize: vertical;
  }
  .mcp-verify { margin-top: 10px; display: grid; gap: 6px; }
  .mcp-verify .inline-result { word-break: break-word; }

  .mcp-dialog {
    width: min(620px, calc(100vw - 28px)); max-height: calc(100vh - 40px);
    border: 1px solid var(--border); border-radius: 18px; padding: 22px;
    color: var(--text); background: #fbfaf6; box-shadow: 0 28px 90px rgba(18,18,16,0.24);

    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); margin: 0;
  }
  .mcp-dialog::backdrop { background: rgba(20,20,18,0.5); backdrop-filter: blur(3px); }
  .mcp-dialog-head {
    display: flex; align-items: flex-start; justify-content: space-between; gap: 18px;
    padding-bottom: 14px; border-bottom: 1px solid var(--border);
  }
  .mcp-dialog-head .card-title { margin: 4px 0 0; }
  .mcp-dialog-close {
    border: 0; background: transparent; color: var(--muted); cursor: pointer;
    font-size: 1.6rem; line-height: 1; padding: 2px 5px;
  }
  .mcp-dialog-desc { color: var(--muted); line-height: 1.55; font-size: 0.88rem; }
  .mcp-install-preview {
    display: grid; gap: 6px; padding: 12px; border-radius: 10px;
    background: #1d211f; color: #f5f2e9;
  }
  .mcp-install-preview span {
    color: #aeb8b1; font-size: 0.66rem; font-weight: 700;
    letter-spacing: 0.08em; text-transform: uppercase;
  }
  .mcp-install-preview code {
    color: #f5f2e9; background: transparent; word-break: break-all; font-size: 0.78rem;
  }
  .mcp-security-note, .mcp-replace-note {
    margin-top: 12px; padding: 10px 12px; border-radius: 9px;
    font-size: 0.78rem; line-height: 1.5;
  }
  .mcp-security-note.local {
    background: rgba(220,38,38,0.08); border: 1px solid rgba(185,28,28,0.18); color: #991b1b;
  }
  .mcp-security-note.remote {
    background: rgba(59,130,246,0.08); border: 1px solid rgba(29,78,216,0.16); color: #1e40af;
  }
  .mcp-replace-note { background: rgba(217,119,6,0.1); color: #92400e; }
  .mcp-credential { display: grid; gap: 5px; margin-top: 14px; }
  .mcp-credential span { font-size: 0.78rem; font-weight: 650; }
  .mcp-credential input {
    width: 100%; padding: 9px 10px; border: 1px solid var(--border); border-radius: 8px;
    background: #fff; color: var(--text); font: 0.8rem/1.3 'JetBrains Mono', ui-monospace, monospace;
  }
  .mcp-credential small, .mcp-secret-note, .mcp-no-credentials {
    color: var(--subtle); font-size: 0.72rem; line-height: 1.45;
  }
  .mcp-secret-note { margin: 14px 0 8px; }
  .mcp-no-credentials { margin: 14px 0 0; }
  #mcp-dialog-error, #mcp-custom-dialog-error { margin-top: 14px; }
  .mcp-dialog-actions {
    display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px;
    padding-top: 14px; border-top: 1px solid var(--border);
  }



  .events-list { display: flex; flex-direction: column; gap: 8px; }
  .event-row {
    padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px;
    background: rgba(0,0,0,0.02);
  }
  .event-row-top {
    display: flex; align-items: center; justify-content: space-between;
    gap: 10px;
  }
  .event-name { min-width: 0; flex: 1; word-break: break-all; }
  .event-name code { font-size: 0.82rem; background: transparent; padding: 0; }
  .event-meta { font-size: 0.74rem; color: var(--muted); margin-top: 3px; }
  .event-text {
    font-size: 0.82rem; color: var(--text); margin-top: 6px;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    white-space: pre-wrap; word-break: break-word;
  }
  .event-delete-btn {
    flex-shrink: 0; padding: 4px 10px;
    border-radius: 7px; border: 1px solid rgba(185, 28, 28, 0.18);
    background: rgba(0,0,0,0.03); color: var(--err-text);
    font: 500 0.76rem/1.2 'DM Sans', sans-serif; cursor: pointer;
  }
  .event-delete-btn:hover:not(:disabled) {
    background: var(--err-bg); border-color: rgba(185, 28, 28, 0.28);
  }
  .event-delete-btn:disabled { opacity: 0.5; cursor: wait; }



  .conv-list { display: flex; flex-direction: column; gap: 6px; }
  .conv-row-btn {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 14px; border: 1px solid var(--border); border-radius: 10px;
    background: rgba(0,0,0,0.02); cursor: pointer; text-align: left;
    transition: background 120ms, border-color 120ms;
  }
  .conv-row-btn:hover { background: rgba(0,0,0,0.05); border-color: rgba(0,0,0,0.14); }
  .conv-id { flex: 1; font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.84rem; }
  .conv-last { color: var(--subtle); font-size: 0.78rem; }

  .usage-table-wrap { overflow-x: auto; }
  .usage-table { width: 100%; border-collapse: collapse; font-size: 0.78rem; }
  .usage-table th, .usage-table td {
    padding: 8px 10px; border-bottom: 1px solid var(--border);
    text-align: left; white-space: nowrap;
  }
  .usage-table th {
    color: var(--subtle); font-size: 0.68rem;
    text-transform: uppercase; letter-spacing: 0.08em;
  }
  .usage-table code { font-size: 0.72rem; }

  .timeline-controls {
    display: flex; flex-wrap: wrap; gap: 18px; align-items: center; margin-bottom: 16px;
  }
  .timeline-controls label {
    display: flex; align-items: center; gap: 8px;
    font-size: 0.76rem; color: var(--muted);
  }
  .timeline-controls select {
    padding: 6px 10px; border: 1px solid var(--border); border-radius: 8px;
    background: #fff; color: var(--text); font-size: 0.8rem; max-width: 240px;
  }
  .tl-note { margin-top: 8px; font-size: 0.72rem; color: var(--subtle); }
  .tl-cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 16px; }
  .tl-card { background: rgba(0,0,0,0.025); border-radius: 10px; padding: 10px 12px; }
  .tl-card-label { font-size: 0.73rem; color: var(--muted); margin-bottom: 4px; }
  .tl-card-value { font-size: 1.35rem; font-weight: 600; color: var(--text); }
  .tl-legend { display: flex; gap: 16px; font-size: 0.73rem; color: var(--muted); margin-bottom: 10px; }
  .tl-legend span { display: inline-flex; align-items: center; gap: 6px; }
  .tl-legend-item { cursor: pointer; transition: opacity 100ms; }
  .tl-legend-item:hover { text-decoration: underline; }
  .tl-legend-item.active { color: var(--text); font-weight: 600; text-decoration: underline; }
  .tl-legend-item.dim { opacity: 0.4; }
  .sw { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
  .sw-cache-read { background: rgba(0,0,0,0.18); }
  .sw-cache-write { background: #3b6fb0; }
  .sw-input { background: var(--accent); }
  .sw-output { background: var(--ok-text); }
  .tl-chart {
    position: relative;
    display: flex; align-items: flex-end; gap: 6px;
    height: 216px; border-bottom: 1px solid var(--border);
  }
  .tl-peak {
    position: absolute; left: 0; right: 0; height: 0;
    border-top: 1px dashed var(--accent); pointer-events: none;
  }
  .tl-peak-label {
    position: absolute; left: 0; top: -15px;
    font-size: 0.7rem; color: var(--accent); white-space: nowrap;
  }
  .tl-bar {
    position: relative; flex: 1; min-width: 0; height: 180px;
    display: flex; flex-direction: column; justify-content: flex-end;
    border-radius: 6px 6px 0 0; transition: background 80ms ease;
  }
  .tl-bar:hover { background: rgba(0,0,0,0.06); }
  .tl-bar:hover .tl-seg { opacity: 0.55; }
  .tl-fill {
    display: flex; flex-direction: column; justify-content: flex-end;
    border-radius: 3px 3px 0 0; overflow: hidden;
  }
  .tl-tip {
    position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%);
    margin-bottom: 6px; padding: 5px 9px; border-radius: 6px;
    background: var(--text); color: #fafafa; font-size: 0.7rem; line-height: 1.35;
    white-space: nowrap; opacity: 0; pointer-events: none; z-index: 5;
  }
  .tl-bar:hover .tl-tip { opacity: 1; }
  .tl-seg { display: block; width: 100%; }
  .tl-seg.tl-output { background: var(--ok-text); }
  .tl-seg.tl-input { background: var(--accent); }
  .tl-seg.tl-cache-write { background: #3b6fb0; }
  .tl-seg.tl-cache-read { background: rgba(0,0,0,0.18); }
  .tl-empty { display: block; width: 100%; height: 3px; background: var(--border); }
  .tl-axis { display: flex; justify-content: space-between; margin-top: 6px; font-size: 0.7rem; color: var(--subtle); }

  .status-pill {
    display: inline-flex; padding: 2px 9px; border-radius: 999px;
    font-size: 0.7rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
  }
  .status-pill.running { background: var(--ok-bg); color: var(--ok-text); border: 1px solid var(--ok-border); }

  @media (max-width: 860px) {
    .settings-shell { grid-template-columns: 1fr; }
    .settings-rail { position: static; }

    .rail-nav {
      flex-direction: row; flex-wrap: nowrap; gap: 6px;
      overflow-x: auto; padding-bottom: 6px;

      min-width: 0; max-width: 100%;
      scrollbar-width: thin; -webkit-overflow-scrolling: touch;
    }
    .settings-rail { min-width: 0; }
    .rail-nav[hidden] { display: none; }
    .rail-link { flex: 0 0 auto; padding: 7px 11px; }
    .rail-link span { white-space: nowrap; }
  }

  @media (max-width: 640px) {
    .config-grid { grid-template-columns: 1fr; }
    .config-row { grid-template-columns: 1fr; gap: 4px; }
    .workspace-split { grid-template-columns: 1fr; }
    .workspace-tree, .workspace-preview { max-height: 260px; }
    .mcp-preset-grid { grid-template-columns: 1fr; }
    .mcp-dialog { padding: 18px; }
  }
`;
