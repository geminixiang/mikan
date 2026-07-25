import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createRemoteTaskTool, remoteTaskBridgeUrl } from "../src/tools/remote-task.js";

const BRIDGE = "https://sandbox.example";

function okResponse(body: object) {
  return { ok: true, text: async () => JSON.stringify(body) };
}

function bodyOf(fetchMock: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> {
  return JSON.parse(fetchMock.mock.calls[call][1].body) as Record<string, unknown>;
}

describe("remote_task tool", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.MIKAN_CLOUDFLARE_SANDBOX_URL = BRIDGE;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  test("posts the command to the bridge and returns its output", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ stdout: "hello\n", code: 0 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await createRemoteTaskTool().execute("call-1", { command: "echo hello" });

    expect(result.content).toEqual([{ type: "text", text: "hello\n" }]);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/exec", BRIDGE),
      expect.objectContaining({ method: "POST" }),
    );
    expect(bodyOf(fetchMock)).toMatchObject({ command: "echo hello", cwd: "/workspace" });
  });

  test("gives every call its own throwaway sandbox", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ stdout: "", code: 0 }));
    vi.stubGlobal("fetch", fetchMock);
    const tool = createRemoteTaskTool();

    await Promise.all([
      tool.execute("call-1", { command: "a" }),
      tool.execute("call-2", { command: "b" }),
    ]);

    const first = bodyOf(fetchMock, 0).sandboxId as string;
    const second = bodyOf(fetchMock, 1).sandboxId as string;
    expect(first).toMatch(/^mikan-task-/);
    expect(second).not.toBe(first);
  });

  test("never sends credentials to the remote sandbox", async () => {
    // A task executor holds no vault: it gets only what the command carries.
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ stdout: "", code: 0 }));
    vi.stubGlobal("fetch", fetchMock);

    await createRemoteTaskTool().execute("call-1", { command: "env" });

    expect(bodyOf(fetchMock)).not.toHaveProperty("env");
  });

  test("surfaces a non-zero exit with the output attached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(okResponse({ stdout: "partial", stderr: "boom", code: 3 })),
    );

    await expect(createRemoteTaskTool().execute("call-1", { command: "false" })).rejects.toThrow(
      /partial\nboom[\s\S]*exited with code 3/,
    );
  });

  test("reports a bridge error instead of a bare HTTP status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        text: async () => JSON.stringify({ error: "sandbox pool exhausted" }),
      }),
    );

    await expect(createRemoteTaskTool().execute("call-1", { command: "pwd" })).rejects.toThrow(
      "sandbox pool exhausted",
    );
  });

  test("is unavailable when no bridge is configured", async () => {
    delete process.env.MIKAN_CLOUDFLARE_SANDBOX_URL;
    delete process.env.CLOUDFLARE_SANDBOX_URL;

    expect(remoteTaskBridgeUrl()).toBeUndefined();
    await expect(createRemoteTaskTool().execute("call-1", { command: "pwd" })).rejects.toThrow(
      /CLOUDFLARE_SANDBOX_URL is not set/,
    );
  });

  test("aborts with the caller's signal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: URL, init: { signal: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }),
    );
    const controller = new AbortController();
    const running = createRemoteTaskTool().execute(
      "call-1",
      { command: "sleep 60" },
      controller.signal,
    );
    controller.abort();

    await expect(running).rejects.toThrow("remote_task aborted");
  });
});
