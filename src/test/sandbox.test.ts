import { afterEach, describe, expect, test, vi } from "vitest";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import * as log from "../log.js";
import { SandboxError } from "../sandbox/utils.js";
import {
  warnUnenforcedPrivateOffice,
  createSandboxEnv,
  parseSandboxArg,
} from "../sandbox/registry.js";

describe("parseSandboxArg", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("parses host sandbox", () => {
    expect(parseSandboxArg("host")).toEqual({ type: "host" });
  });

  test("parses container sandbox", () => {
    expect(parseSandboxArg("container:mikan-sandbox")).toEqual({
      type: "container",
      container: "mikan-sandbox",
    });
  });

  test("parses image sandbox for managed per-user containers", () => {
    expect(parseSandboxArg("image:ubuntu:24.04")).toEqual({
      type: "image",
      image: "ubuntu:24.04",
    });
  });

  test("removed backends are rejected as invalid sandbox types", () => {
    expect(() => parseSandboxArg("gondolin:default")).toThrowError(SandboxError);
    expect(() => parseSandboxArg("firecracker:vm1:/srv/workspace")).toThrowError(SandboxError);
    expect(() => parseSandboxArg("cloudflare:slack-u123")).toThrowError(SandboxError);
  });

  test("rejects unsupported sandbox type", () => {
    expect(() => parseSandboxArg("podman:mikan")).toThrowError(SandboxError);
    expect(() => parseSandboxArg("podman:mikan")).toThrow(
      "Error: Invalid sandbox type 'podman:mikan'",
    );
  });

  test("rejects docker mode with migration hint", () => {
    expect(() => parseSandboxArg("docker:mikan-sandbox")).toThrowError(SandboxError);
    expect(() => parseSandboxArg("docker:mikan-sandbox")).toThrow(
      "Use 'container:<container-name>' for the shared-container mode",
    );
  });
});

describe("warnUnenforcedPrivateOffice", () => {
  test.each([
    { type: "host" } as const,
    { type: "container", container: "mikan-sandbox" } as const,
  ])("warns once about an unenforced private office on $type", (sandboxConfig) => {
    const warn = vi.spyOn(log, "logWarning").mockImplementation(() => {});
    const key = `k-${sandboxConfig.type}`;
    warnUnenforcedPrivateOffice(sandboxConfig, "private", key);
    warnUnenforcedPrivateOffice(sandboxConfig, "private", key);
    warnUnenforcedPrivateOffice(sandboxConfig, "public", key);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/cannot enforce private office visibility/);
    warn.mockRestore();
  });

  test("image mode enforces visibility silently", () => {
    const warn = vi.spyOn(log, "logWarning").mockImplementation(() => {});
    warnUnenforcedPrivateOffice({ type: "image", image: "ubuntu:24.04" }, "private", "k");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("createSandboxEnv", () => {
  test("creates Pi's Node environment for the host", () => {
    expect(createSandboxEnv({ type: "host" }, { cwd: "/w" })).toBeInstanceOf(NodeExecutionEnv);
  });

  test("creates a container environment", () => {
    const env = createSandboxEnv(
      { type: "container", container: "mikan-sandbox" },
      { cwd: "/workspace" },
    );
    expect(env.id).toBe("container:mikan-sandbox");
    expect(env.cwd).toBe("/workspace");
  });

  test("rejects an unresolved image sandbox", () => {
    expect(() =>
      createSandboxEnv({ type: "image", image: "ubuntu:24.04" }, { cwd: "/workspace" }),
    ).toThrowError(SandboxError);
  });
});
