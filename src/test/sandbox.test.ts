import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withAbortSignal } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import * as log from "../log.js";
import { ContainerExecutionEnv } from "../sandbox/container.js";
import { SandboxError } from "../sandbox/utils.js";
import {
  warnUnenforcedPrivateOffice,
  createSandboxEnv,
  parseSandboxArg,
} from "../sandbox/registry.js";
import { TEST_CONTEXT } from "./tool-api.js";

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
    expect(
      createSandboxEnv({ type: "container", container: "mikan-sandbox" }, { cwd: "/workspace" }),
    ).toBeInstanceOf(ContainerExecutionEnv);
  });

  test("rejects an unresolved image sandbox", () => {
    expect(() =>
      createSandboxEnv({ type: "image", image: "ubuntu:24.04" }, { cwd: "/workspace" }),
    ).toThrowError(SandboxError);
  });
});

function recordingDocker(): { docker: string; calls: () => string[][]; envFiles: () => string[] } {
  const dir = mkdtempSync(join(tmpdir(), "mikan-docker-record-"));
  dirs.push(dir);
  const docker = join(dir, "docker");
  writeFileSync(
    docker,
    [
      "#!/bin/sh",
      `sep=$(printf '\\037'); line=; for arg in "$@"; do line="$line$arg$sep"; done`,
      `printf '%s\\n' "$line" >> ${dir}/calls`,
      `prev=; for arg in "$@"; do [ "$prev" = --env-file ] && cat "$arg" >> ${dir}/env && echo --- >> ${dir}/env; prev=$arg; done`,
      'case "$*" in *"sleep 300"*) exec sleep 30 ;; esac',
    ].join("\n"),
  );
  chmodSync(docker, 0o755);
  const read = (name: string) => {
    try {
      return readFileSync(join(dir, name), "utf8");
    } catch {
      return "";
    }
  };
  return {
    docker,
    calls: () =>
      read("calls")
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split("\x1f").slice(0, -1)),
    envFiles: () => read("env").split("---\n").filter(Boolean),
  };
}

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function env(docker: string, credentials?: Record<string, string>): ContainerExecutionEnv {
  return new ContainerExecutionEnv({
    container: "mikan-sandbox",
    cwd: "/workspace",
    env: credentials,
    docker,
    ensureReady: async () => {},
  });
}

describe("ContainerExecutionEnv docker invocation", () => {
  test("runs in the guest cwd as one argument, without a host shell", async () => {
    const recorder = recordingDocker();

    await env(recorder.docker).exec("pwd", { cwd: "/guest-only/work space" }, TEST_CONTEXT);

    const [call] = recorder.calls();
    expect(call?.slice(0, 4)).toEqual(["exec", "-w", "/guest-only/work space", "mikan-sandbox"]);
    expect(call?.slice(-3)).toEqual(["sh", "-c", "pwd"]);
  });

  test("configures the gh git credential helper through env without writing git config", async () => {
    const recorder = recordingDocker();

    await env(recorder.docker, { GH_TOKEN: "gho_test" }).exec(
      "git clone https://github.com/acme/skills.git",
      undefined,
      TEST_CONTEXT,
    );

    expect(recorder.envFiles()[0]?.split("\n")).toEqual([
      "GH_TOKEN=gho_test",
      "GIT_CONFIG_COUNT=2",
      "GIT_CONFIG_KEY_0=credential.https://github.com.helper",
      "GIT_CONFIG_VALUE_0=",
      "GIT_CONFIG_KEY_1=credential.https://github.com.helper",
      "GIT_CONFIG_VALUE_1=!gh auth git-credential",
      "",
    ]);
  });

  test("leaves env untouched without a GitHub token", async () => {
    const recorder = recordingDocker();

    await env(recorder.docker, { FOO: "bar" }).exec("true", undefined, TEST_CONTEXT);

    expect(recorder.envFiles()).toEqual(["FOO=bar\n"]);
  });

  test.each(["aborted", "timeout"] as const)(
    "kills the guest process group when the command is %s",
    async (outcome) => {
      const recorder = recordingDocker();
      const controller = new AbortController();
      const running = env(recorder.docker).exec(
        "sleep 300",
        outcome === "timeout" ? { timeout: 1 } : undefined,
        withAbortSignal(controller.signal, TEST_CONTEXT),
      );
      await vi.waitFor(() => expect(recorder.calls()).toHaveLength(1));
      if (outcome === "aborted") controller.abort();

      const result = await running;

      expect(result.ok ? "ok" : result.error.code).toBe(outcome);
      const calls = recorder.calls();
      const groupFile = calls[0]?.find((arg) => arg.startsWith("/tmp/mikan-exec-"));
      expect(groupFile).toBeDefined();
      expect(calls).toHaveLength(2);
      expect(calls[1]?.slice(0, 4)).toEqual(["exec", "mikan-sandbox", "sh", "-c"]);
      expect(calls[1]?.at(-1)).toBe(groupFile);
    },
  );

  test("does not kill anything after a command that finished", async () => {
    const recorder = recordingDocker();

    const result = await env(recorder.docker).exec("true", undefined, TEST_CONTEXT);

    expect(result.ok && result.value.exitCode).toBe(0);
    expect(recorder.calls()).toHaveLength(1);
  });
});
