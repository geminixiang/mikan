import { execFile, execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { withAbortSignal } from "@earendil-works/chord/context";
import { afterAll, describe, expect, test } from "vitest";
import { ContainerExecutionEnv, sweepOrphanedCommands } from "../sandbox/container.js";
import { TEST_CONTEXT } from "./tool-api.js";
import { containerEngine } from "../sandbox/engine.js";

const ENGINE = containerEngine();
const CANDIDATE_IMAGES = [
  "docker.io/library/debian:trixie-slim",
  "docker.io/library/alpine:latest",
];

function localImages(): string[] {
  if (spawnSync(ENGINE, ["info"], { stdio: "ignore" }).status !== 0) return [];
  return CANDIDATE_IMAGES.filter(
    (image) => spawnSync(ENGINE, ["image", "inspect", image], { stdio: "ignore" }).status === 0,
  );
}

const images = localImages();
const containers: string[] = [];

function startContainer(image: string): string {
  const name = `mikan-exec-test-${randomUUID().slice(0, 8)}`;
  execFileSync(ENGINE, [
    "run",
    "-d",
    "--name",
    name,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    image,
    "sleep",
    "infinity",
  ]);
  containers.push(name);
  return name;
}

function guestCommandLines(container: string): string[] {
  const script = 'for p in /proc/[0-9]*; do tr "\\0" " " < "$p/cmdline" 2>/dev/null; echo; done';
  return execFileSync(ENGINE, ["exec", container, "sh", "-c", script])
    .toString()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

afterAll(() => {
  for (const name of containers) spawnSync(ENGINE, ["rm", "-f", name], { stdio: "ignore" });
});

function containerEnv(container: string, docker?: string): ContainerExecutionEnv {
  return new ContainerExecutionEnv({ container, cwd: "/tmp", docker, ensureReady: async () => {} });
}

function dockerWithoutGroupKill(): string {
  const dir = mkdtempSync(join(tmpdir(), "mikan-docker-crash-"));
  const docker = join(dir, "docker");
  writeFileSync(
    docker,
    `#!/bin/sh\ncase "$*" in *stop_group*) exit 0 ;; esac\nexec ${JSON.stringify(ENGINE)} "$@"\n`,
  );
  chmodSync(docker, 0o755);
  cleanupDirs.push(dir);
  return docker;
}

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

describe.runIf(images.length > 0)("ContainerExecutionEnv against a real container", () => {
  test.each(images)(
    "aborting a command ends its whole process group in %s",
    async (image) => {
      const container = startContainer(image);
      const controller = new AbortController();
      const running = containerEnv(container).exec(
        "sleep 300; echo finished",
        undefined,
        withAbortSignal(controller.signal, TEST_CONTEXT),
      );
      await expect
        .poll(() => guestCommandLines(container).some((line) => line === "sleep 300"), {
          timeout: 10_000,
        })
        .toBe(true);

      controller.abort();

      const result = await running;
      expect(result.ok ? "ok" : result.error.code).toBe("aborted");
      expect(guestCommandLines(container).filter((line) => line.includes("sleep 300"))).toEqual([]);
    },
    30_000,
  );

  test.each(images)(
    "cleanup ends every command the environment still runs in %s",
    async (image) => {
      const container = startContainer(image);
      const env = containerEnv(container);
      const running = env.exec("sleep 301", undefined, TEST_CONTEXT);
      await expect
        .poll(() => guestCommandLines(container).includes("sleep 301"), { timeout: 10_000 })
        .toBe(true);

      await env.cleanup(TEST_CONTEXT);

      await running;
      expect(guestCommandLines(container).filter((line) => line.includes("sleep 301"))).toEqual([]);
    },
    30_000,
  );

  test.each(images)(
    "keeps output streams and exit code of a finished command in %s",
    async (image) => {
      const container = startContainer(image);
      const output = { stdout: "", stderr: "" };
      const result = await containerEnv(container).exec(
        "echo out; echo err >&2; exit 7",
        { onOutput: (text, _context, info) => (output[info.stream] += text) },
        TEST_CONTEXT,
      );

      expect(result.ok && result.value.exitCode).toBe(7);
      expect(output).toEqual({ stdout: "out\n", stderr: "err\n" });
    },
    30_000,
  );

  test.each(images)(
    "the startup sweep ends a command left by a crashed process in %s",
    async (image) => {
      const container = startContainer(image);
      const controller = new AbortController();
      const running = containerEnv(container, dockerWithoutGroupKill()).exec(
        "sleep 300",
        undefined,
        withAbortSignal(controller.signal, TEST_CONTEXT),
      );
      await expect
        .poll(() => guestCommandLines(container).includes("sleep 300"), { timeout: 10_000 })
        .toBe(true);
      controller.abort();
      await running;
      expect(guestCommandLines(container)).toContain("sleep 300");
      execFileSync(ENGINE, ["exec", container, "sh", "-c", 'echo "1 0" > /tmp/mikan-exec-stale']);

      await sweepOrphanedCommands(container, promisify(execFile));

      expect(guestCommandLines(container).filter((line) => line.includes("sleep 300"))).toEqual([]);
      expect(guestCommandLines(container)).toContain("sleep infinity");
      const leftover = execFileSync(ENGINE, ["exec", container, "sh", "-c", "ls /tmp"]);
      expect(leftover.toString()).not.toContain("mikan-exec-");
    },
    30_000,
  );
});
