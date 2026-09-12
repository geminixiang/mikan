import { describe, expect, test, vi } from "vitest";

const client = vi.hoisted(() => ({
  connect: vi.fn(),
  listTools: vi.fn(),
  close: vi.fn(),
  getInstructions: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = client.connect;
    listTools = client.listTools;
    close = client.close;
    getInstructions = client.getInstructions;
  },
}));

import { loadMcpTools } from "../harness/mcp.js";
import { SessionStore } from "../harness/session-store.js";

describe("MCP connection rollback", () => {
  test("the pending session owns connections and preserves guidance across prompt replacements", async () => {
    client.connect.mockReset().mockResolvedValue(undefined);
    client.listTools.mockReset().mockResolvedValue({ tools: [] });
    client.getInstructions.mockReset().mockReturnValue("Use the service safely");
    client.close.mockReset().mockResolvedValue(undefined);
    const store = SessionStore.inMemory("/work");
    await store.connectMcp({ service: { command: "unused" } });
    expect(store.withMcpInstructions("first")).toContain("Use the service safely");
    expect(store.withMcpInstructions("second")).toMatch(/^second\n\n/);
    await Promise.all([store.close(), store.close()]);
    expect(client.close).toHaveBeenCalledOnce();
    await expect(store.connectMcp({})).rejects.toThrow("closed");
  });

  test("closing after partial MCP initialization releases successful clients despite a close failure", async () => {
    client.connect.mockReset().mockResolvedValue(undefined);
    client.listTools
      .mockReset()
      .mockResolvedValueOnce({ tools: [] })
      .mockRejectedValueOnce(new Error("discovery failed"));
    client.getInstructions.mockReset().mockReturnValue(undefined);
    client.close
      .mockReset()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("transport close failed"));
    const store = SessionStore.inMemory("/work");
    await store.connectMcp({ good: { command: "unused" }, bad: { command: "unused" } });
    expect(client.close).toHaveBeenCalledTimes(1);
    await store.close();
    await store.close();
    expect(client.close).toHaveBeenCalledTimes(2);
  });

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
