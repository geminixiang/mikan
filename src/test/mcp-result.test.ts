import { describe, expect, it } from "vitest";
import { boundMcpText, mcpResultContent } from "../harness/mcp-result.js";

const limits = { maxBytes: 2000, maxLines: 100 };

function githubLikeSearch(count: number) {
  return {
    ok: true,
    data: {
      total_count: 691,
      incomplete_results: false,
      items: Array.from({ length: count }, (_, index) => ({
        number: index + 1,
        title: `Issue ${index + 1}`,
        body: "x".repeat(4000),
        user: { login: "octo", id: 1, avatar_url: "https://avatars.example/u/1" },
        labels: [{ name: "bug" }],
      })),
      nextCursor: "cursor-2",
    },
  };
}

describe("mcpResultContent", () => {
  it("passes an embedded image resource to the model as an image", () => {
    expect(
      mcpResultContent({
        content: [
          {
            type: "resource",
            resource: { uri: "file:///chart.png", mimeType: "image/png", blob: "aW1n" },
          },
        ],
      }),
    ).toEqual([{ type: "image", data: "aW1n", mimeType: "image/png" }]);
  });

  it("reports an empty result", () => {
    expect(mcpResultContent({ content: [] })).toEqual([{ type: "text", text: "(empty result)" }]);
  });
});

describe("boundMcpText", () => {
  it("compacts pretty-printed JSON without truncating it", () => {
    const pretty = JSON.stringify({ ok: true, data: { items: [1, 2, 3] } }, null, 2);
    expect(boundMcpText(pretty, limits)).toEqual({
      text: '{"ok":true,"data":{"items":[1,2,3]}}',
    });
  });

  it("leaves small non-JSON text unchanged", () => {
    expect(boundMcpText("plain answer", limits)).toEqual({
      text: "plain answer",
    });
  });

  it("digests oversized JSON while keeping keys, counts, and pagination", () => {
    const bounded = boundMcpText(JSON.stringify(githubLikeSearch(100), null, 2), limits);

    expect(bounded.digest).toBe(true);
    expect(Buffer.byteLength(bounded.text)).toBeLessThanOrEqual(limits.maxBytes);
    const digest = JSON.parse(bounded.text);
    expect(digest.data.total_count).toBe(691);
    expect(digest.data.nextCursor).toBe("cursor-2");
    expect(digest.data.items.at(-1)).toMatch(/^…\[\+\d+ more items\]$/);
    expect(digest.data.items[0].number).toBe(1);
    expect(digest.data.items[0].title).toBe("Issue 1");
    expect(digest.data.items[0].body).toMatch(/^x+…\[\+\d+ chars\]$/);
  });

  it("head-truncates oversized non-JSON text", () => {
    const text = Array.from({ length: 500 }, (_, index) => `line ${index}`).join("\n");
    const bounded = boundMcpText(text, limits);
    expect(bounded.text).not.toBe(text);
    expect(bounded.text.startsWith("line 0\nline 1")).toBe(true);
    expect(bounded.text.split("\n").length).toBeLessThanOrEqual(limits.maxLines);
  });

  it("fits a single huge string within the byte limit", () => {
    const bounded = boundMcpText(JSON.stringify({ html: "<p>".repeat(100_000) }), limits);
    expect(bounded.digest).toBe(true);
    expect(Buffer.byteLength(bounded.text)).toBeLessThanOrEqual(limits.maxBytes);
    expect(JSON.parse(bounded.text).html).toMatch(/…\[\+\d+ chars\]$/);
  });
});
