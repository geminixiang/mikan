import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, test, vi } from "vitest";

// Execute the actual embedded script without its page-load requests.
const source = readFileSync(new URL("../web/admin/portal.ts", import.meta.url), "utf8");
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
  const context = {
    defaultConversationKey: "slack:C1",
    adminToken: "secret",
    document: { getElementById: get, addEventListener: vi.fn(), querySelectorAll: () => [] },
    fetch,
  };
  runInNewContext(script.slice(0, script.indexOf("    // ── Init")), context);
  return { get, fetch, run: (code: string) => runInNewContext(code, context) };
}

describe("admin embedded UI shared flows", () => {
  test.each([
    ["openLogin", "vault", "login"],
    ["openSessionView", "session", "session"],
  ])("%s retains route, frame, escaping and silent reset", async (action, resultId, kind) => {
    const p = page();
    await p.run(`${action}()`);
    expect(p.fetch.mock.calls[0]?.[0]).toBe(`/admin/api/conversations/${kind}-link`);
    const result = p.get(`${resultId}-link-result`);
    expect(result.innerHTML).toContain("a=1&amp;b=2");
    expect(result.innerHTML.includes("&lt;vault&gt;")).toBe(kind === "login");
    expect(p.get(`${kind}-frame`).src).toContain("example.com");
    await p.run(`${action}(true)`);
    expect(result.style.display).toBe("none");
    expect(p.get(`${kind}-frame`).removeAttribute).toHaveBeenCalledWith("src");
  });

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
      "saveConversationSetting(document.getElementById('button'), document.getElementById('result'), 'sandbox', { doorPolicy: 'isolated' }, 'Save door policy', () => { document.getElementById('callback').textContent = 'called'; })",
    );
    expect(p.fetch.mock.calls[0]?.[0]).toBe("/admin/api/conversations/sandbox");
    expect(JSON.parse(p.fetch.mock.calls[0]?.[1].body)).toEqual({
      token: "secret",
      platform: "slack",
      conversationId: "C1",
      doorPolicy: "isolated",
    });
    expect(p.get("result").textContent).toBe("Saved ✓");
    expect(p.get("callback").textContent).toBe("called");
    expect(p.get("button").textContent).toBe("Save door policy");
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
