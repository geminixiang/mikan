import { afterEach, describe, expect, test, vi } from "vitest";
import { CloudflareSandboxExecutor, cloudflareSandboxAdapter } from "../src/index.js";

describe("cloudflareSandboxAdapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("parses the cloudflare grammar", () => {
    expect(cloudflareSandboxAdapter.parse("cloudflare:slack-u123")).toEqual({
      type: "cloudflare",
      sandboxId: "slack-u123",
    });
    expect(cloudflareSandboxAdapter.parse("host")).toBeUndefined();
    expect(() => cloudflareSandboxAdapter.parse("cloudflare:")).toThrow();
  });

  test("declares conversation-scoped credential routing with ambient vault", () => {
    expect(cloudflareSandboxAdapter.credentials).toEqual({ env: true, fileMounts: false });
    expect(cloudflareSandboxAdapter.workspace).toEqual({ managedProjection: false });
    expect(cloudflareSandboxAdapter.vault).toEqual({
      routingLabel: "conversation",
      ambientSharedVault: true,
    });
  });

  test("resolves sandbox ids scoped to the resource key", () => {
    const resolved = cloudflareSandboxAdapter.resolveRuntimeConfig?.(
      { type: "cloudflare", sandboxId: "slack-u123" },
      { resourceKey: "c123", workspaceRoot: "/ws", mounts: [] },
    );
    expect(resolved).toEqual({ type: "cloudflare", sandboxId: "slack-u123-c123" });
  });

  test("describes itself for the startup log", () => {
    expect(
      cloudflareSandboxAdapter.describe?.({ type: "cloudflare", sandboxId: "slack-u123" }),
    ).toBe("cloudflare:slack-u123");
  });

  test("creates a CloudflareSandboxExecutor and reads MIKAN_-prefixed env", () => {
    vi.stubEnv("MIKAN_CLOUDFLARE_SANDBOX_CWD", "/remote/ws");
    const executor = cloudflareSandboxAdapter.createExecutor?.({
      type: "cloudflare",
      sandboxId: "slack-u123",
    });
    expect(executor).toBeInstanceOf(CloudflareSandboxExecutor);
    expect(executor?.getWorkspacePath("/host/ws")).toBe("/remote/ws");
  });
});
