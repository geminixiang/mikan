import { afterEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import * as log from "../log.js";
import { ContainerExecutor } from "../sandbox/container.js";
import { HostExecutor } from "../sandbox/host.js";
import { SandboxError } from "../sandbox/utils.js";
import {
  warnUnenforcedPrivateOffice,
  createExecutor,
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

describe("createExecutor", () => {
  test("creates host executor", () => {
    expect(createExecutor({ type: "host" })).toBeInstanceOf(HostExecutor);
  });

  test("creates container executor", () => {
    expect(createExecutor({ type: "container", container: "mikan-sandbox" })).toBeInstanceOf(
      ContainerExecutor,
    );
  });

  test("rejects unresolved image executor", () => {
    expect(() => createExecutor({ type: "image", image: "ubuntu:24.04" })).toThrowError(
      SandboxError,
    );
  });
});

describe("ContainerExecutor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("applies guest cwd only to docker, preserving host timeout and cancellation", async () => {
    const exec = vi
      .spyOn(HostExecutor.prototype, "exec")
      .mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    const executor = new ContainerExecutor("mikan-sandbox", undefined, async () => {});
    const signal = new AbortController().signal;

    await executor.exec("pwd", { cwd: "/guest-only/work space", timeout: 5, signal });

    expect(exec).toHaveBeenCalledWith(expect.stringContaining("-w '/guest-only/work space'"), {
      timeout: 5,
      signal,
    });
  });

  test("configures the gh git credential helper through env without writing git config", async () => {
    let envFile = "";
    vi.spyOn(HostExecutor.prototype, "exec").mockImplementation(async (command) => {
      const path = /--env-file '([^']+)'/.exec(command)?.[1];
      envFile = path ? readFileSync(path, "utf8") : "";
      return { stdout: "", stderr: "", code: 0 };
    });
    const executor = new ContainerExecutor(
      "mikan-sandbox",
      { GH_TOKEN: "gho_test" },
      async () => {},
    );

    await executor.exec("git clone https://github.com/acme/skills.git");

    expect(envFile.split("\n")).toEqual([
      "GH_TOKEN=gho_test",
      "GIT_CONFIG_COUNT=2",
      "GIT_CONFIG_KEY_0=credential.https://github.com.helper",
      "GIT_CONFIG_VALUE_0=",
      "GIT_CONFIG_KEY_1=credential.https://github.com.helper",
      "GIT_CONFIG_VALUE_1=!gh auth git-credential",
      "",
    ]);
  });

  test.each([
    ["aborted", "Command aborted"],
    ["timed out", "Command timed out after 5 seconds"],
  ])("kills the guest process group when the command is %s", async (_case, failure) => {
    const commands: string[] = [];
    vi.spyOn(HostExecutor.prototype, "exec").mockImplementation(async (command) => {
      commands.push(command);
      if (commands.length === 1) throw new Error(failure);
      return { stdout: "", stderr: "", code: 0 };
    });
    const executor = new ContainerExecutor("mikan-sandbox", undefined, async () => {});
    const controller = new AbortController();
    if (failure === "Command aborted") controller.abort();

    await expect(
      executor.exec("sleep 300", { timeout: 5, signal: controller.signal }),
    ).rejects.toThrow(failure);

    const groupFile = /'(\/tmp\/mikan-exec-[^']+)'/.exec(commands[0] ?? "")?.[1];
    expect(groupFile).toBeDefined();
    expect(commands).toHaveLength(2);
    expect(commands[1]).toContain("docker exec mikan-sandbox sh -c");
    expect(commands[1]).toContain(groupFile);
  });

  test("does not kill anything after a command that finished", async () => {
    const exec = vi
      .spyOn(HostExecutor.prototype, "exec")
      .mockResolvedValue({ stdout: "ok", stderr: "", code: 0 });
    const executor = new ContainerExecutor("mikan-sandbox", undefined, async () => {});

    await expect(executor.exec("true")).resolves.toMatchObject({ stdout: "ok" });

    expect(exec).toHaveBeenCalledTimes(1);
  });

  test("leaves env untouched without a GitHub token", async () => {
    let envFile = "";
    vi.spyOn(HostExecutor.prototype, "exec").mockImplementation(async (command) => {
      const path = /--env-file '([^']+)'/.exec(command)?.[1];
      envFile = path ? readFileSync(path, "utf8") : "";
      return { stdout: "", stderr: "", code: 0 };
    });
    const executor = new ContainerExecutor("mikan-sandbox", { FOO: "bar" }, async () => {});

    await executor.exec("true");

    expect(envFile).toBe("FOO=bar\n");
  });
});
