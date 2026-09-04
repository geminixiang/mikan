import { describe, expect, test, vi } from "vitest";

const client = vi.hoisted(() => ({
  connect: vi.fn(),
  listTools: vi.fn(),
  close: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = client.connect;
    listTools = client.listTools;
    close = client.close;
  },
}));

import { loadMcpTools } from "../mcp/loader.js";

describe("MCP connection rollback", () => {
  test("closes a client when shutdown aborts connection", async () => {
    const controller = new AbortController();
    client.connect.mockReset().mockImplementation(
      (_transport: unknown, options: { signal?: AbortSignal }) =>
        new Promise<void>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(options.signal?.reason));
        }),
    );
    client.listTools.mockReset();
    client.close.mockReset().mockResolvedValue(undefined);

    const loading = loadMcpTools({ slow: { command: "unused" } }, controller.signal);
    controller.abort(new Error("shutdown"));
    const result = await loading;

    expect(result.errors).toEqual([{ server: "slow", error: "shutdown" }]);
    expect(client.listTools).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledOnce();
  });

  test("closes a connected client when tool discovery fails", async () => {
    const failure = new Error("tool listing failed");
    client.connect.mockReset().mockResolvedValue(undefined);
    client.listTools.mockReset().mockRejectedValue(failure);
    client.close.mockReset().mockResolvedValue(undefined);

    const result = await loadMcpTools({ broken: { command: "unused" } });

    expect(result.tools).toEqual([]);
    expect(result.errors).toEqual([{ server: "broken", error: failure.message }]);
    expect(client.close).toHaveBeenCalledOnce();
  });

  test("keeps the discovery error primary when client cleanup also fails", async () => {
    const failure = new Error("tool listing failed");
    client.connect.mockReset().mockResolvedValue(undefined);
    client.listTools.mockReset().mockRejectedValue(failure);
    client.close.mockReset().mockRejectedValue(new Error("close failed"));

    const result = await loadMcpTools({ broken: { command: "unused" } });

    expect(result.errors).toEqual([{ server: "broken", error: failure.message }]);
    expect(client.close).toHaveBeenCalledOnce();
  });
});
