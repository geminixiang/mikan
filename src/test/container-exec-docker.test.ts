import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { withAbortSignal } from "@earendil-works/chord/context";
import { afterAll, describe, expect, test } from "vitest";
import { createContainerExecutionEnv } from "../sandbox/container.js";
import { containerEngine } from "../sandbox/engine.js";
import { TEST_CONTEXT } from "./tool-api.js";

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

function running(container: string, command: string): boolean {
  return guestCommandLines(container).some((line) => line.endsWith(command));
}

afterAll(() => {
  for (const name of containers) {
    spawnSync(ENGINE, ["kill", name], { stdio: "ignore" });
    spawnSync(ENGINE, ["rm", "-f", name], { stdio: "ignore" });
  }
});

function containerEnv(container: string) {
  return createContainerExecutionEnv({
    container,
    cwd: "/tmp",
    engine: ENGINE,
    ensureReady: async () => {},
  });
}

describe.runIf(images.length > 0)("container ExecutionEnv against a real container", () => {
  test.each(images)(
    "aborting a command ends it in %s",
    async (image) => {
      const container = startContainer(image);
      const controller = new AbortController();
      const result = containerEnv(container).exec(
        "sleep 300; echo finished",
        undefined,
        withAbortSignal(controller.signal, TEST_CONTEXT),
      );
      await expect.poll(() => running(container, "sleep 300"), { timeout: 10_000 }).toBe(true);

      controller.abort();

      const settled = await result;
      expect(settled.ok ? "ok" : settled.error.code).toBe("aborted");
      await expect.poll(() => running(container, "sleep 300"), { timeout: 5_000 }).toBe(false);
    },
    30_000,
  );

  test.each(images)(
    "cleanup ends every command the environment still runs in %s",
    async (image) => {
      const container = startContainer(image);
      const env = containerEnv(container);
      const result = env.exec("sleep 301", undefined, TEST_CONTEXT);
      await expect.poll(() => running(container, "sleep 301"), { timeout: 10_000 }).toBe(true);

      await env.cleanup(TEST_CONTEXT);

      await result;
      await expect.poll(() => running(container, "sleep 301"), { timeout: 5_000 }).toBe(false);
    },
    30_000,
  );

  test.each(images)(
    "commands end when mikan's connection to the container ends in %s",
    async (image) => {
      const container = startContainer(image);
      const result = containerEnv(container).exec("sleep 302", undefined, TEST_CONTEXT);
      await expect.poll(() => running(container, "sleep 302"), { timeout: 10_000 }).toBe(true);

      spawnSync("sh", ["-c", 'pkill -KILL -f "exec -i $0 /tmp/mikan-pi-env-"', container]);

      await expect.poll(() => running(container, "sleep 302"), { timeout: 45_000 }).toBe(false);
      await result;
    },
    60_000,
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
    "reconnects after the container restarts in %s",
    async (image) => {
      const container = startContainer(image);
      const env = containerEnv(container);
      expect((await env.writeFile("/tmp/kept", "kept", TEST_CONTEXT)).ok).toBe(true);

      execFileSync(ENGINE, ["restart", "-t", "0", container]);

      await expect
        .poll(async () => await env.readTextFile("/tmp/kept", TEST_CONTEXT), { timeout: 10_000 })
        .toEqual({ ok: true, value: "kept" });
    },
    30_000,
  );
});
