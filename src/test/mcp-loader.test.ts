import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadMcpTools } from "../mcp/loader.js";

// A minimal MCP server as a standalone script, spawned over stdio like a real
// deployment would. It exposes one echo tool and reads a secret from its env
// to prove credentials flow through server config, not the model context.
// Imports are absolute file URLs because the script lives in a tmpdir with no
// node_modules of its own.
const sdkUrl = (subpath: string) =>
  new URL(`../../node_modules/@modelcontextprotocol/sdk/dist/esm/${subpath}`, import.meta.url).href;
const zodUrl = new URL("../../node_modules/zod/index.js", import.meta.url).href;
const SERVER_SCRIPT = `
import { McpServer } from ${JSON.stringify(sdkUrl("server/mcp.js"))};
import { StdioServerTransport } from ${JSON.stringify(sdkUrl("server/stdio.js"))};
import { z } from ${JSON.stringify(zodUrl)};

const server = new McpServer({ name: "test-server", version: "1.0.0" });
server.registerTool(
  "echo",
  {
    description: "Echo a message back",
    inputSchema: { message: z.string() },
  },
  async ({ message }) => ({
    content: [{ type: "text", text: "echo:" + message + ":" + (process.env.TEST_SECRET ?? "") }],
  }),
);
server.registerTool(
  "boom",
  { description: "Always fails", inputSchema: {} },
  async () => ({ isError: true, content: [{ type: "text", text: "kaboom" }] }),
);
await server.connect(new StdioServerTransport());
`;

const dir = mkdtempSync(join(tmpdir(), "mikan-mcp-test-"));
const serverPath = join(dir, "server.mjs");
writeFileSync(serverPath, SERVER_SCRIPT);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadMcpTools", () => {
  it("connects over stdio, namespaces tools, and pipes env credentials", async () => {
    const result = await loadMcpTools({
      test: {
        command: process.execPath,
        args: [serverPath],
        env: { TEST_SECRET: "s3cret" },
      },
    });
    try {
      expect(result.errors).toEqual([]);
      const names = result.tools.map((tool) => tool.name);
      expect(names).toContain("mcp__test__echo");
      expect(names).toContain("mcp__test__boom");

      const echo = result.tools.find((tool) => tool.name === "mcp__test__echo")!;
      expect(echo.parameters).toMatchObject({ type: "object" });
      const echoed = await echo.execute("call-1", { message: "hi" });
      expect(echoed.content).toEqual([{ type: "text", text: "echo:hi:s3cret" }]);

      // isError results become throws — the AgentTool failure contract.
      const boom = result.tools.find((tool) => tool.name === "mcp__test__boom")!;
      await expect(boom.execute("call-2", {})).rejects.toThrow("kaboom");
    } finally {
      await result.dispose();
    }
  }, 30_000);

  it("reports unreachable servers as errors without failing the rest", async () => {
    const result = await loadMcpTools({
      good: { command: process.execPath, args: [serverPath] },
      bad: { command: "/nonexistent/definitely-not-a-binary" },
    });
    try {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.server).toBe("bad");
      expect(result.tools.some((tool) => tool.name === "mcp__good__echo")).toBe(true);
    } finally {
      await result.dispose();
    }
  }, 30_000);

  it("skips disabled servers and rejects invalid entries", async () => {
    const disabled = await loadMcpTools({
      off: { command: process.execPath, args: [serverPath], disabled: true },
    });
    expect(disabled.tools).toEqual([]);
    expect(disabled.errors).toEqual([]);
    await disabled.dispose();

    const invalid = await loadMcpTools({
      "bad name!": { command: "true" },
      both: { command: "true", url: "https://example.com/mcp" },
      neither: {},
    });
    expect(invalid.tools).toEqual([]);
    expect(invalid.errors.map((error) => error.server).toSorted()).toEqual([
      "bad name!",
      "both",
      "neither",
    ]);
    await invalid.dispose();
  }, 30_000);
});
