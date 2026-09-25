import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TODO_CONTEXT,
  createReadTool,
  type AgentHarnessToolInvocation,
  type ExecutionToolContext,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { afterAll, describe, expect, it } from "vitest";
import { formatMcpServerInstructions, loadMcpTools } from "../harness/mcp.js";
import type { MikanHarnessTool } from "../harness/types.js";

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
server.registerTool(
  "big",
  { description: "Return a large pretty-printed page", inputSchema: {} },
  async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            total_count: 691,
            nextCursor: "cursor-2",
            items: Array.from({ length: 100 }, (_, index) => ({
              number: index + 1,
              body: "x".repeat(2000),
            })),
          },
          null,
          2,
        ),
      },
    ],
  }),
);
server.registerTool(
  "structured",
  { description: "Return only structured content", inputSchema: {} },
  async () => ({ content: [], structuredContent: { answer: 42 } }),
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

const invocation: AgentHarnessToolInvocation = {
  invocationId: "inv",
  operationId: "op",
  turnId: "turn",
  getMemo: async () => undefined,
  setMemo: async () => {},
};

function callTool(tool: MikanHarnessTool, params: Record<string, unknown>, cwd = dir) {
  return tool.execute(
    "call",
    params,
    () => {},
    { env: new NodeExecutionEnv({ cwd }) },
    invocation,
    TODO_CONTEXT,
  );
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
      const echoed = await callTool(echo, { message: "hi" });
      expect(echoed.content).toEqual([{ type: "text", text: "echo:hi:s3cret" }]);

      const boom = result.tools.find((tool) => tool.name === "mcp__test__boom")!;
      await expect(callTool(boom, {})).rejects.toThrow("kaboom");
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
      const executed = await callTool(execute, {
        actionId: "github.create_issue",
      });
      expect(executed.content).toEqual([{ type: "text", text: "executed:github.create_issue:" }]);

      const explicit = await callTool(execute, {
        actionId: "multi.read",
        connectionName: "account-b",
      });
      expect(explicit.content).toEqual([{ type: "text", text: "executed:multi.read:account-b" }]);
    } finally {
      await result.dispose();
      await new Promise<void>((resolve) => http.server.close(() => resolve()));
    }
  });

  it("bounds oversized results and spills the full result into the runtime workspace", async () => {
    const result = await loadMcpTools({ test: { command: process.execPath, args: [serverPath] } });
    const cwd = mkdtempSync(join(tmpdir(), "mikan-mcp-spill-"));
    try {
      const big = result.tools.find((tool) => tool.name === "mcp__test__big")!;
      const output = await callTool(big, {}, cwd);
      const [block] = output.content;
      const text = block?.type === "text" ? block.text : "";
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(50 * 1024);
      const [digest, notice] = text.split("\n\n");
      const parsed = JSON.parse(digest!);
      expect(parsed.total_count).toBe(691);
      expect(parsed.nextCursor).toBe("cursor-2");
      expect(parsed.items.at(-1)).toBe("…[+97 more items]");
      const spillPath = /Full result: (\S+)/.exec(notice!)?.[1];
      expect(spillPath?.startsWith(join(cwd, ".mikan", "mcp-output"))).toBe(true);
      const spilled = JSON.parse(readFileSync(spillPath!, "utf-8"));
      expect(spilled.items).toHaveLength(100);
      const readTool = createReadTool<ExecutionToolContext>();
      const read = await readTool.execute(
        "read",
        { path: spillPath!, limit: 20 },
        () => {},
        { env: new NodeExecutionEnv({ cwd }) },
        invocation,
        TODO_CONTEXT,
      );
      const readText = read.content[0]?.type === "text" ? read.content[0].text : "";
      expect(readText).not.toContain("exceeds");
      expect(readText).toContain('"total_count": 691');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await result.dispose();
    }
  }, 30_000);

  it("falls back to structuredContent when a result has no content blocks", async () => {
    const result = await loadMcpTools({ test: { command: process.execPath, args: [serverPath] } });
    try {
      const structured = result.tools.find((tool) => tool.name === "mcp__test__structured")!;
      expect((await callTool(structured, {})).content).toEqual([
        { type: "text", text: '{"answer":42}' },
      ]);
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
