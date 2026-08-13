import { describe, expect, test } from "vitest";
import { ContainerExecutor, containerSandboxAdapter } from "../src/index.js";

describe("containerSandboxAdapter", () => {
  test("parses the container grammar", () => {
    expect(containerSandboxAdapter.parse("container:mikan-sandbox")).toEqual({
      type: "container",
      container: "mikan-sandbox",
    });
    expect(containerSandboxAdapter.parse("host")).toBeUndefined();
    expect(() => containerSandboxAdapter.parse("container:")).toThrow();
  });

  test("declares container-scoped credential routing", () => {
    expect(containerSandboxAdapter.credentials).toEqual({ env: true, fileMounts: false });
    expect(containerSandboxAdapter.workspace).toEqual({ managedProjection: false });
    expect(containerSandboxAdapter.vault).toEqual({
      routingLabel: "container",
      ambientSharedVault: false,
    });
  });

  test("describes itself for the startup log", () => {
    expect(containerSandboxAdapter.describe?.({ type: "container", container: "alice-box" })).toBe(
      "container:alice-box",
    );
  });

  test("creates a ContainerExecutor for the configured container", () => {
    const executor = containerSandboxAdapter.createExecutor?.({
      type: "container",
      container: "alice-box",
    });
    expect(executor).toBeInstanceOf(ContainerExecutor);
    expect(executor?.getWorkspacePath("/host/ws")).toBe("/workspace");
    expect(executor?.getSandboxConfig()).toEqual({ type: "container", container: "alice-box" });
  });
});
