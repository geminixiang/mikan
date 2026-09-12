import { describe, expect, it } from "vitest";
import { isValidMcpServerName, parseStandardMcpServers, redactMcpUrl } from "../harness/mcp.js";

describe("parseStandardMcpServers", () => {
  it("stores a pasted mcpServers block as-is, Bearer header intact", () => {
    const result = parseStandardMcpServers(
      JSON.stringify({
        mcpServers: {
          browser: {
            type: "http",
            url: "https://mcp.example.test/mcp",
            headers: { Authorization: "Bearer abc def" },
          },
          local: { command: "npx", args: ["-y", "pkg"], env: { TOKEN: "x y" } },
        },
      }),
    );
    expect(result.servers).toEqual({
      browser: {
        url: "https://mcp.example.test/mcp",
        headers: { Authorization: "Bearer abc def" },
      },
      local: { command: "npx", args: ["-y", "pkg"], env: { TOKEN: "x y" } },
    });
  });

  it("accepts a bare name-keyed map", () => {
    expect(
      parseStandardMcpServers(JSON.stringify({ a: { url: "https://a.test/mcp" } })).servers,
    ).toEqual({ a: { url: "https://a.test/mcp" } });
  });

  it("rejects malformed input with a specific message", () => {
    expect(parseStandardMcpServers("{").error).toMatch(/not valid JSON/);
    expect(parseStandardMcpServers("{}").error).toMatch(/no servers/);
    expect(parseStandardMcpServers(JSON.stringify({ mcpServers: [] })).error).toMatch(/keyed by/);
    expect(
      parseStandardMcpServers(JSON.stringify({ "bad name": { url: "https://s.test" } })).error,
    ).toMatch(/invalid server name/);
    expect(parseStandardMcpServers(JSON.stringify({ s: { type: "http" } })).error).toMatch(
      /either command/,
    );
    expect(
      parseStandardMcpServers(JSON.stringify({ s: { url: "mcp.example/mcp" } })).error,
    ).toMatch(/not a valid URL/);
    expect(
      parseStandardMcpServers(JSON.stringify({ s: { url: "https://s.test", command: "npx" } }))
        .error,
    ).toMatch(/only one/);
  });

  it("shares the server-name grammar with the loader", () => {
    expect(isValidMcpServerName("browserless")).toBe(true);
    expect(isValidMcpServerName("1abc")).toBe(false);
  });
});

describe("redactMcpUrl", () => {
  it("hides every query value but keeps the path", () => {
    expect(redactMcpUrl("https://mcp.example.test/mcp?token=secret&region=eu")).toBe(
      "https://mcp.example.test/mcp?token=<redacted>&region=<redacted>",
    );
    expect(redactMcpUrl("https://mcp.example.test/mcp")).toBe("https://mcp.example.test/mcp");
  });
});
