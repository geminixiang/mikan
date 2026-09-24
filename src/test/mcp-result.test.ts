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
  it("keeps text and image blocks", () => {
    const blocks = mcpResultContent({
      content: [
        { type: "text", text: "hello" },
        { type: "image", data: "aW1n", mimeType: "image/png" },
      ],
    });
    expect(blocks).toEqual([
      { type: "text", text: "hello" },
      { type: "image", data: "aW1n", mimeType: "image/png" },
    ]);
  });

  it("uses structuredContent only when content is empty", () => {
    expect(mcpResultContent({ content: [], structuredContent: { a: 1 } })).toEqual([
      { type: "text", text: '{"a":1}' },
    ]);
    expect(
      mcpResultContent({ content: [{ type: "text", text: "t" }], structuredContent: { a: 1 } }),
    ).toEqual([{ type: "text", text: "t" }]);
  });

  it("describes binary resources instead of inlining their bytes", () => {
    const [block] = mcpResultContent({
      content: [
        {
          type: "resource",
          resource: { uri: "file:///a.bin", mimeType: "application/pdf", blob: "A".repeat(4000) },
        },
      ],
    });
    expect(block).toEqual({
      type: "text",
      text: "[Resource: file:///a.bin (application/pdf, 3000 bytes, binary content omitted)]",
    });
  });

  it("inlines text resources and summarizes links and audio", () => {
    const blocks = mcpResultContent({
      content: [
        { type: "resource", resource: { uri: "file:///a.txt", text: "body" } },
        { type: "resource_link", uri: "https://x.example/r", name: "report" },
        { type: "audio", data: "AAAA", mimeType: "audio/wav" },
      ],
    });
    expect(blocks).toEqual([
      { type: "text", text: "[Resource: file:///a.txt]\nbody" },
      { type: "text", text: "[Resource link: report] https://x.example/r" },
      { type: "text", text: "[Audio content omitted: audio/wav]" },
    ]);
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
      truncated: false,
    });
  });

  it("leaves small non-JSON text unchanged", () => {
    expect(boundMcpText("plain answer", limits)).toEqual({
      text: "plain answer",
      truncated: false,
    });
  });

  it("digests oversized JSON while keeping keys, counts, and pagination", () => {
    const bounded = boundMcpText(JSON.stringify(githubLikeSearch(100), null, 2), limits);

    expect(bounded.truncated).toBe(true);
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
    expect(bounded.truncated).toBe(true);
    expect(bounded.text.startsWith("line 0\nline 1")).toBe(true);
    expect(bounded.text.split("\n").length).toBeLessThanOrEqual(limits.maxLines);
  });

  it("fits a single huge string within the byte limit", () => {
    const bounded = boundMcpText(JSON.stringify({ html: "<p>".repeat(100_000) }), limits);
    expect(bounded.truncated).toBe(true);
    expect(Buffer.byteLength(bounded.text)).toBeLessThanOrEqual(limits.maxBytes);
    expect(JSON.parse(bounded.text).html).toMatch(/…\[\+\d+ chars\]$/);
  });
});
