import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, test, vi } from "vitest";

// Execute the actual embedded script without its page-load requests.
const source = readFileSync(new URL("../adapters/web/admin/portal.ts", import.meta.url), "utf8");
const literal = source
  .slice(
    source.indexOf("const adminViewScript = `") + "const adminViewScript = ".length,
    source.indexOf("function renderAdminPage"),
  )
  .trim()
  .replace(/;$/, "");
const script = runInNewContext(literal) as string;

function page() {
  const nodes = new Map<
    string,
    {
      style: Record<string, string>;
      innerHTML: string;
      textContent: string;
      className: string;
      src: string;
      removeAttribute: ReturnType<typeof vi.fn>;
      addEventListener: ReturnType<typeof vi.fn>;
    }
  >();
  const get = (id: string) => {
    if (!nodes.has(id))
      nodes.set(id, {
        style: {},
        innerHTML: "",
        textContent: "",
        className: "",
        src: "",
        removeAttribute: vi.fn(),
        addEventListener: vi.fn(),
      });
    return nodes.get(id)!;
  };
  const fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ url: "https://example.com/?a=1&b=2", vaultId: "<vault>", events: [] }),
  });
  const windowOpen = vi.fn();
  const context = {
    defaultConversationKey: "slack:C1",
    adminToken: "secret",
    document: { getElementById: get, addEventListener: vi.fn(), querySelectorAll: () => [] },
    fetch,
    window: { open: windowOpen },
  };
  runInNewContext(script.slice(0, script.indexOf("    // ── Init")), context);
  return {
    get,
    fetch,
    windowOpen,
    run: (code: string) => runInNewContext(code, context),
  };
}

describe("admin embedded UI shared flows", () => {
  test.each(["renderSettings", "renderGlobalSettings"])(
    "%s retains cards, selected values and escaping",
    (render) => {
      const p = page();
      const global = render === "renderGlobalSettings";
      const html = p.run(
        `${render}({ thinkingLevel: 'high', slack: { replyMode: 'thread' }, officeVisibility: 'private', officeVisibilitySource: 'override', officeVisibilityOverride: 'private', autoReplyRules: ['<rule>'] })`,
      ) as string;
      expect(html.match(/class="config-block"/g)).toHaveLength(3);
      expect(html).toContain('<option value="high" selected>high</option>');
      expect(html).toContain('<option value="thread" selected>thread</option>');
      if (!global) {
        expect(html).toContain('id="m-visibility" checked');
        expect(html).toContain("<strong>Hidden</strong>");
      }
      const ids = global
        ? [
            "g-model-ref",
            "g-thinking",
            "g-cpus",
            "g-mem",
            "g-bcpus",
            "g-bmem",
            "g-slack-reply-mode",
            "g-model-result",
            "g-sandbox-result",
            "g-slack-result",
          ]
        : [
            "m-model-ref",
            "m-thinking",
            "m-visibility",
            "m-slack-reply-mode",
            "model-save-result",
            "mount-save-result",
            "slack-save-result",
          ];
      for (const id of ids) expect(html).toContain(`id="${id}"`);
      expect(html).not.toContain("auto-save-result");
    },
  );

  test("visibility card offers the hide switch only to public Slack channels", () => {
    const p = page();
    const render = (fields: string) =>
      p.run(
        `renderSettings({ thinkingLevel: 'high', slack: { replyMode: 'thread' }, autoReplyRules: [], ${fields} })`,
      ) as string;

    const publicChannel = render(
      "officeVisibility: 'public', officeVisibilitySource: 'platform', officeVisibilityOverride: undefined",
    );
    expect(publicChannel).toContain('<input type="checkbox" id="m-visibility">');
    expect(publicChannel).toContain("<strong>Shared</strong>");
    expect(publicChannel).toContain("saveVisibility(this)");

    const dm = render(
      "officeVisibility: 'private', officeVisibilitySource: 'platform', officeVisibilityOverride: undefined",
    );
    expect(dm).not.toContain('id="m-visibility"');
    expect(dm).toContain("DM or private channel");
    expect(dm).not.toContain("saveVisibility(this)");

    const unknown = render(
      "officeVisibility: 'private', officeVisibilitySource: 'unknown', officeVisibilityOverride: undefined",
    );
    expect(unknown).not.toContain('id="m-visibility"');
    expect(unknown).toContain("treated as hidden");
  });

  test("saveVisibility maps the hide switch onto the visibility setting", async () => {
    const p = page();
    (p.get("m-visibility") as { checked?: boolean }).checked = true;
    await p.run("saveVisibility(document.getElementById('button'))");
    expect(p.fetch.mock.calls[0]?.[0]).toBe("/admin/api/conversations/visibility");
    const body = JSON.parse(p.fetch.mock.calls[0]?.[1]?.body as string);
    expect(body.visibility).toBe("private");
  });

  test("settings resolve conversation scope after model loading", async () => {
    const p = page();
    let complete!: (response: unknown) => void;
    p.fetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const loading = p.run("loadSettings()");
    expect(p.get("settings-content").innerHTML).toContain("Loading");
    p.run("activeConversationKey = 'telegram:C2'");
    complete({ ok: true, json: async () => ({ models: [] }) });
    await loading;
    expect(p.fetch.mock.calls[1]?.[0]).toContain("conversationId=C2&platform=telegram");
  });

  test.each([["loadMcpServers", "mcp"]])(
    "%s displays escaped errors in both scopes",
    async (load, prefix) => {
      const p = page();
      p.fetch.mockRejectedValue(new Error("<denied>"));
      await p.run(`${load}()`);
      for (const scope of ["conv", "global"])
        expect(p.get(`${prefix}-${scope}-content`).innerHTML).toBe(
          '<div class="err-msg">&lt;denied&gt;</div>',
        );
    },
  );

  test.each([["loadMcpServers", "mcp"]])(
    "%s retains empty-state success and tolerates absent panels",
    async (load, prefix) => {
      const p = page();
      p.fetch.mockResolvedValue({
        ok: true,
        json: async () => ({ conversation: [], global: [], presets: [] }),
      });
      await p.run(`${load}()`);
      expect(p.get(`${prefix}-conv-content`).innerHTML).not.toContain("Loading…");
      expect(p.get(`${prefix}-global-content`).innerHTML).not.toContain("err-msg");
      p.run("document.getElementById = () => null");
      await expect(p.run(`${load}()`)).resolves.toBeUndefined();
    },
  );

  test("global settings loader retains unscoped route and escaped errors", async () => {
    const p = page();
    p.run("modelsLoaded = true");
    p.fetch.mockRejectedValue(new Error("<failed>"));
    await p.run("loadGlobalSettings()");
    expect(p.fetch.mock.calls[0]?.[0]).toBe("/admin/api/settings/global?token=secret");
    expect(p.get("global-settings-content").innerHTML).toBe(
      '<div class="err-msg">&lt;failed&gt;</div>',
    );
  });

  test.each([
    ["openLogin", "vault", "login"],
    ["openSessionView", "session", "session"],
  ])(
    "%s retains route, new-tab open, escaping and silent reset",
    async (action, resultId, kind) => {
      const p = page();
      await p.run(`${action}()`);
      expect(p.fetch.mock.calls[0]?.[0]).toBe(`/admin/api/conversations/${kind}-link`);
      const result = p.get(`${resultId}-link-result`);
      expect(result.innerHTML).toContain("a=1&amp;b=2");
      expect(result.innerHTML.includes("&lt;vault&gt;")).toBe(kind === "login");
      expect(p.windowOpen).toHaveBeenCalledWith(
        "https://example.com/?a=1&b=2",
        "_blank",
        "noopener",
      );
      await p.run(`${action}(true)`);
      expect(result.style.display).toBe("none");
    },
  );

  test.each(["loadConversationEvents", "loadEvents"])(
    "%s retains scope and delete permissions",
    async (action) => {
      const p = page();
      p.fetch.mockResolvedValue({
        ok: true,
        json: async () => ({ events: [{ name: "test", text: "<event>" }] }),
      });
      await p.run(`${action}()`);
      const conversation = action === "loadConversationEvents";
      expect(String(p.fetch.mock.calls[0]?.[0]).includes("conversationId=C1")).toBe(conversation);
      const html = p.get(conversation ? "events-content" : "global-events-content").innerHTML;
      expect(html).toContain("&lt;event&gt;");
      expect(html.includes('data-admin-action="delete-event"')).toBe(conversation);
    },
  );

  test("conversation settings retain scope, token and success callback", async () => {
    const p = page();
    await p.run(
      "saveConversationSetting(document.getElementById('button'), document.getElementById('result'), 'visibility', { visibility: 'private' }, 'Save visibility', () => { document.getElementById('callback').textContent = 'called'; })",
    );
    expect(p.fetch.mock.calls[0]?.[0]).toBe("/admin/api/conversations/visibility");
    expect(JSON.parse(p.fetch.mock.calls[0]?.[1].body)).toEqual({
      token: "secret",
      platform: "slack",
      conversationId: "C1",
      visibility: "private",
    });
    expect(p.get("result").textContent).toBe("Saved ✓");
    expect(p.get("callback").textContent).toBe("called");
    expect(p.get("button").textContent).toBe("Save visibility");
  });

  test("setting failure restores button and exposes error without a success callback", async () => {
    const p = page();
    p.fetch.mockRejectedValue(new Error("denied"));
    await p.run(
      "saveSetting(document.getElementById('button'), document.getElementById('result'), 'settings/slack', { replyMode: 'thread' }, 'Save Slack', () => { throw new Error('unexpected callback'); })",
    );
    expect(p.get("result").textContent).toBe("denied");
    expect(p.get("result").className).toBe("inline-result err");
    expect(p.get("button").textContent).toBe("Save Slack");
  });
});
