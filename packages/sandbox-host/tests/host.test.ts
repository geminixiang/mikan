import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostExecutor, hostSandboxAdapter } from "../src/index.js";

function makeHostExecutor(): HostExecutor {
  const executor = hostSandboxAdapter.createExecutor?.({ type: "host" });
  if (!executor) throw new Error("host adapter must create an executor");
  return executor;
}

describe("hostSandboxAdapter", () => {
  test("parses only the bare host grammar", () => {
    expect(hostSandboxAdapter.parse("host")).toEqual({ type: "host" });
    expect(hostSandboxAdapter.parse("host:anything")).toBeUndefined();
    expect(hostSandboxAdapter.parse("container:mikan-sandbox")).toBeUndefined();
  });

  test("declares no credential or managed-workspace capabilities", () => {
    expect(hostSandboxAdapter.credentials).toEqual({ env: false, fileMounts: false });
    expect(hostSandboxAdapter.workspace).toEqual({ managedProjection: false });
    expect(hostSandboxAdapter.vault).toEqual({ routingLabel: "host", ambientSharedVault: false });
  });

  test("describes itself for the startup log", () => {
    expect(hostSandboxAdapter.describe?.({ type: "host" })).toBe("host");
  });

  test("creates a HostExecutor that runs and reads/writes files", async () => {
    const executor = makeHostExecutor();
    expect(executor).toBeInstanceOf(HostExecutor);

    const result = await executor.exec("printf hello");
    expect(result.stdout).toBe("hello");
    expect(result.code).toBe(0);

    const dir = mkdtempSync(join(tmpdir(), "mikan-sandbox-host-"));
    try {
      const file = join(dir, "nested", "x.txt");
      await executor.writeFile(file, "content");
      expect(await executor.readFile(file)).toBe("content");
      expect(await executor.readFileBase64(file)).toBe("Y29udGVudA==");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("maps the host workspace path identity", () => {
    const executor = makeHostExecutor();
    expect(executor.getWorkspacePath("/host/ws")).toBe("/host/ws");
    const ctx = executor.getPathContext("/host/ws");
    expect(ctx.hostWorkspaceRoot).toBe("/host/ws");
    expect(ctx.runtimeWorkspaceRoot).toBe("/host/ws");
    expect(ctx.runtimeToHostPath?.("/host/ws/file.txt")).toBe("/host/ws/file.txt");
  });
});
