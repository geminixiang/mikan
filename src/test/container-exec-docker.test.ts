import { execFile, execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { ContainerExecutor, sweepOrphanedCommands } from "../sandbox/container.js";
import { HostExecutor } from "../sandbox/host.js";

const EMPTY_RESULT = { stdout: "", stderr: "", code: 0 };
const CANDIDATE_IMAGES = ["debian:trixie-slim", "alpine:latest"];

function localImages(): string[] {
  if (spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0) return [];
  return CANDIDATE_IMAGES.filter(
    (image) => spawnSync("docker", ["image", "inspect", image], { stdio: "ignore" }).status === 0,
  );
}

const images = localImages();
const containers: string[] = [];

function startContainer(image: string): string {
  const name = `mikan-exec-test-${randomUUID().slice(0, 8)}`;
  execFileSync("docker", [
    "run",
    "-d",
    "--rm",
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
  return execFileSync("docker", ["exec", container, "sh", "-c", script])
    .toString()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  for (const name of containers) spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
});

describe.runIf(images.length > 0)("ContainerExecutor against a real container", () => {
  test.each(images)(
    "stopping a command ends its whole process group in %s",
    async (image) => {
      const container = startContainer(image);
      const executor = new ContainerExecutor(container, undefined, async () => {});
      const controller = new AbortController();
      const running = executor.exec("sleep 300; echo finished", {
        cwd: "/tmp",
        signal: controller.signal,
      });
      await expect
        .poll(() => guestCommandLines(container).some((line) => line === "sleep 300"), {
          timeout: 10_000,
        })
        .toBe(true);

      controller.abort();

      await expect(running).rejects.toThrow("Command aborted");
      expect(guestCommandLines(container).filter((line) => line.includes("sleep 300"))).toEqual([]);
    },
    30_000,
  );

  test.each(images)(
    "keeps output and exit code of a finished command in %s",
    async (image) => {
      const container = startContainer(image);
      const executor = new ContainerExecutor(container, undefined, async () => {});

      const result = await executor.exec("echo out; echo err >&2; exit 7", { cwd: "/tmp" });

      expect(result).toEqual({ stdout: "out\n", stderr: "err\n", code: 7 });
    },
    30_000,
  );

  test.each(images)(
    "the startup sweep ends a command left by a crashed process in %s",
    async (image) => {
      const container = startContainer(image);
      const run = HostExecutor.prototype.exec;
      let calls = 0;
      vi.spyOn(HostExecutor.prototype, "exec").mockImplementation(
        function (this: HostExecutor, command, options) {
          calls += 1;
          return calls === 1 ? run.call(this, command, options) : Promise.resolve(EMPTY_RESULT);
        },
      );
      const executor = new ContainerExecutor(container, undefined, async () => {});
      const controller = new AbortController();
      const running = executor.exec("sleep 300", { cwd: "/tmp", signal: controller.signal });
      await expect
        .poll(() => guestCommandLines(container).includes("sleep 300"), { timeout: 10_000 })
        .toBe(true);
      controller.abort();
      await expect(running).rejects.toThrow("Command aborted");
      expect(guestCommandLines(container)).toContain("sleep 300");
      execFileSync("docker", ["exec", container, "sh", "-c", 'echo "1 0" > /tmp/mikan-exec-stale']);

      await sweepOrphanedCommands(container, promisify(execFile));

      expect(guestCommandLines(container).filter((line) => line.includes("sleep 300"))).toEqual([]);
      expect(guestCommandLines(container)).toContain("sleep infinity");
      const leftover = execFileSync("docker", ["exec", container, "sh", "-c", "ls /tmp"]);
      expect(leftover.toString()).not.toContain("mikan-exec-");
    },
    30_000,
  );
});
