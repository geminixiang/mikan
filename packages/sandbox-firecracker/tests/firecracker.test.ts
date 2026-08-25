import { describe, expect, test } from "vitest";
import { FirecrackerExecutor, firecrackerSandboxAdapter } from "../src/index.js";

describe("firecrackerSandboxAdapter", () => {
  test("parses the firecracker grammar with optional ssh user/port", () => {
    expect(firecrackerSandboxAdapter.parse("firecracker:vm1:/home/user/workspace")).toEqual({
      type: "firecracker",
      vmId: "vm1",
      hostPath: "/home/user/workspace",
      sshUser: "root",
      sshPort: 22,
    });
    expect(firecrackerSandboxAdapter.parse("firecracker:vm1:/srv/ws:ubuntu:2222")).toEqual({
      type: "firecracker",
      vmId: "vm1",
      hostPath: "/srv/ws",
      sshUser: "ubuntu",
      sshPort: 2222,
    });
    expect(firecrackerSandboxAdapter.parse("host")).toBeUndefined();
    expect(() => firecrackerSandboxAdapter.parse("firecracker:vm1:/srv/ws:root:99999")).toThrow();
  });

  test("declares conversation-scoped credential routing without ambient vault", () => {
    expect(firecrackerSandboxAdapter.credentials).toEqual({ env: true, fileMounts: false });
    expect(firecrackerSandboxAdapter.workspace).toEqual({ managedProjection: false });
    expect(firecrackerSandboxAdapter.vault).toEqual({
      routingLabel: "conversation",
      ambientSharedVault: false,
    });
  });

  test("describes itself for the startup log", () => {
    expect(
      firecrackerSandboxAdapter.describe?.({
        type: "firecracker",
        vmId: "vm1",
        hostPath: "/srv/ws",
      }),
    ).toBe("firecracker:vm1");
  });

  test("creates a FirecrackerExecutor for the configured VM", () => {
    const executor = firecrackerSandboxAdapter.createExecutor?.({
      type: "firecracker",
      vmId: "vm1",
      hostPath: "/srv/ws",
      sshUser: "root",
      sshPort: 22,
    });
    expect(executor).toBeInstanceOf(FirecrackerExecutor);
    expect(executor?.getWorkspacePath("/host/ws")).toBe("/workspace");
  });
});
