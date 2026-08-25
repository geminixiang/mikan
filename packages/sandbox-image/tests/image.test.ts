import { describe, expect, test } from "vitest";
import { imageSandboxAdapter, type ImageSandboxConfig } from "../src/index.js";

describe("imageSandboxAdapter", () => {
  test("parses the image grammar", () => {
    expect(imageSandboxAdapter.parse("image:ubuntu:24.04")).toEqual({
      type: "image",
      image: "ubuntu:24.04",
    });
    expect(imageSandboxAdapter.parse("host")).toBeUndefined();
    expect(() => imageSandboxAdapter.parse("image:")).toThrow();
  });

  test("declares conversation-scoped capabilities with ambient shared vault", () => {
    expect(imageSandboxAdapter.credentials).toEqual({ env: true, fileMounts: true });
    expect(imageSandboxAdapter.workspace).toEqual({ managedProjection: true });
    expect(imageSandboxAdapter.vault).toEqual({
      routingLabel: "conversation",
      ambientSharedVault: true,
    });
  });

  test("resolves image configs to the managed container name", () => {
    const resolved = imageSandboxAdapter.resolveRuntimeConfig?.(
      { type: "image", image: "ubuntu:24.04" },
      { resourceKey: "slack-u123", workspaceRoot: "/ws", mounts: [] },
    );
    expect(resolved).toEqual({ type: "container", container: "mikan-sandbox-slack-u123" });
  });

  test("declares the provisioner image and describes the startup log", () => {
    const config: ImageSandboxConfig = { type: "image", image: "ubuntu:24.04" };
    expect(imageSandboxAdapter.provisionerImage?.(config)).toBe("ubuntu:24.04");
    expect(imageSandboxAdapter.describe?.(config)).toBe("image:ubuntu:24.04");
  });

  test("ensure-ready provisions the managed container via the injected provisioner", async () => {
    let provisioned = 0;
    const provisioner = {
      provision: async (key: string, options: { containerName?: string }) => {
        provisioned += 1;
        expect(key).toBe("slack-u123");
        expect(options.containerName).toBe("mikan-sandbox-slack-u123");
        return options.containerName ?? "";
      },
    };
    const ensureReady = imageSandboxAdapter.createEnsureReady?.(
      { type: "image", image: "ubuntu:24.04" },
      {
        provisioner,
        resourceKey: "slack-u123",
        credentialKey: "vault-u123",
        mounts: [],
        conversationId: "C123",
        hasVault: false,
      },
    );
    expect(ensureReady).toBeDefined();
    await ensureReady!();
    expect(provisioned).toBe(1);
  });

  test("ensure-ready rejects a mismatched provisioner container", async () => {
    const provisioner = {
      provision: async () => "some-other-container",
    };
    const ensureReady = imageSandboxAdapter.createEnsureReady?.(
      { type: "image", image: "ubuntu:24.04" },
      {
        provisioner,
        resourceKey: "slack-u123",
        credentialKey: "vault-u123",
        mounts: [],
        conversationId: "C123",
        hasVault: false,
      },
    );
    await expect(ensureReady!()).rejects.toThrow(/expected "mikan-sandbox-slack-u123"/);
  });
});
