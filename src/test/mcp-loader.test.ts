import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { formatMcpServerInstructions, loadMcpTools } from "../mcp/loader.js";

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

function startHttpMcpServer(): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/mcp") {
      res.writeHead(405).end();
      return;
    }
    if (req.headers.authorization !== "Bearer scoped-token") {
      res.writeHead(401).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as {
      id?: string | number;
      method?: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
    if (message.method === "notifications/initialized") {
      res.writeHead(202).end();
      return;
    }
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "http-test", version: "1.0.0" },
            instructions: "Search for an action before executing it.",
          }
        : message.method === "tools/list"
          ? {
              tools: [
                {
                  name: "list_connections",
                  description: "List connected accounts",
                  inputSchema: {
                    type: "object",
                    properties: { service: { type: "string" } },
                  },
                },
                {
                  name: "execute_action",
                  description: "Execute one connected action",
                  inputSchema: {
                    type: "object",
                    properties: {
                      actionId: { type: "string" },
                      connectionName: { type: "string" },
                    },
                    required: ["actionId"],
                  },
                },
              ],
            }
          : message.params?.name === "list_connections"
            ? {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      ok: true,
                      data:
                        message.params.arguments?.service === "multi"
                          ? [
                              { service: "multi", connectionName: "account-a" },
                              { service: "multi", connectionName: "account-b" },
                            ]
                          : [
                              {
                                service: message.params.arguments?.service,
                                connectionName: "only-account",
                              },
                            ],
                    }),
                  },
                ],
              }
            : {
                content: [
                  {
                    type: "text",
                    text: `executed:${String(message.params?.arguments?.actionId ?? "")}:${String(message.params?.arguments?.connectionName ?? "")}`,
                  },
                ],
              };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${address.port}/mcp` });
    });
  });
}

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

  it("connects over HTTP and sends host-side authorization headers", async () => {
    const http = await startHttpMcpServer();
    const result = await loadMcpTools({
      "open-connector": {
        url: http.url,
        headers: { Authorization: "Bearer scoped-token" },
      },
    });
    try {
      expect(result.errors).toEqual([]);
      expect(result.instructions).toEqual([
        {
          server: "open-connector",
          text: "Search for an action before executing it.",
        },
      ]);
      expect(formatMcpServerInstructions(result.instructions)).toContain(
        "### open-connector\nSearch for an action before executing it.",
      );
      const execute = result.tools.find(
        (tool) => tool.name === "mcp__open-connector__execute_action",
      )!;
      const executed = await execute.execute("call-http", {
        actionId: "github.create_issue",
      });
      expect(executed.content).toEqual([
        { type: "text", text: "executed:github.create_issue:only-account" },
      ]);

      const ambiguous = await execute.execute("call-multi", { actionId: "multi.read" });
      expect(ambiguous.content).toEqual([{ type: "text", text: "executed:multi.read:" }]);

      const explicit = await execute.execute("call-explicit", {
        actionId: "multi.read",
        connectionName: "account-b",
      });
      expect(explicit.content).toEqual([{ type: "text", text: "executed:multi.read:account-b" }]);
    } finally {
      await result.dispose();
      await new Promise<void>((resolve) => http.server.close(() => resolve()));
    }
  });

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
    expect(disabled.instructions).toEqual([]);
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
