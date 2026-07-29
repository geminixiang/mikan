import { describe, expect, test } from "vitest";
import { escapeHtml } from "../utils/html.js";

describe("escapeHtml", () => {
  test("escapes ampersand", () => {
    expect(escapeHtml("a&b")).toBe("a&amp;b");
  });

  test("escapes less-than", () => {
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
  });

  test("escapes greater-than", () => {
    expect(escapeHtml("a > b")).toBe("a &gt; b");
  });

  test("escapes double quote", () => {
    expect(escapeHtml('"hello"')).toBe("&quot;hello&quot;");
  });

  test("escapes single quote", () => {
    expect(escapeHtml("'hello'")).toBe("&#39;hello&#39;");
  });

  test("handles string with no special characters", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });

  test("handles empty string", () => {
    expect(escapeHtml("")).toBe("");
  });

  test("handles all special characters together", () => {
    const input = '<script alert("xss")>& more\x27';
    const result = escapeHtml(input);
    expect(result).toBe("&lt;script alert(&quot;xss&quot;)&gt;&amp; more&#39;");
    expect(result).not.toContain("<");
    expect(result).not.toContain(">");
    expect(result).not.toContain('"');
    expect(result).not.toContain("\x27");
  });

  test("handles multiple consecutive special chars", () => {
    expect(escapeHtml("<<>>\"'&")).toBe("&lt;&lt;&gt;&gt;&quot;&#39;&amp;");
  });
});
