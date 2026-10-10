import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, test } from "vitest";
import { registerEnvConformance } from "@earendil-works/pi-durable/testing";
import { ContainerExecutionEnv } from "../sandbox/container.js";
import { TEST_CONTEXT } from "./tool-api.js";
import { containerEngine } from "../sandbox/engine.js";

const ENGINE = containerEngine();

function removeContainer(name: string): void {
  spawnSync(ENGINE, ["kill", name], { stdio: "ignore" });
  spawnSync(ENGINE, ["rm", "-f", name], { stdio: "ignore" });
}

interface Backend {
  name: string;
  makeDir(): string;
  removeDir(dir: string): void;
  env(cwd: string, env?: Record<string, string>): ContainerExecutionEnv;
}

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function hostShimBackend(): Backend | undefined {
  if (process.platform !== "linux") return undefined;
  const shimDir = mkdtempSync(join(tmpdir(), "mikan-docker-shim-"));
  cleanups.push(() => rmSync(shimDir, { recursive: true, force: true }));
  const docker = join(shimDir, "docker");
  writeFileSync(
    docker,
    [
      "#!/bin/sh",
      '[ "$1" = exec ] || exit 2; shift; cwd=',
      'while :; do case "$1" in',
      "  -i) shift ;;",
      '  --env-file) while IFS= read -r line; do export "$line"; done < "$2"; shift 2 ;;',
      "  -w) cwd=$2; shift 2 ;;",
      "  *) break ;;",
      "esac; done",
      'shift; if [ -n "$cwd" ]; then cd "$cwd" || exit 126; fi; exec "$@"',
    ].join("\n"),
  );
  chmodSync(docker, 0o755);
  return {
    name: "host shim",
    makeDir: () => mkdtempSync(join(tmpdir(), "mikan-container-env-")),
    removeDir: (dir) => rmSync(dir, { recursive: true, force: true }),
    env: (cwd, env) =>
      new ContainerExecutionEnv({
        container: "shim",
        cwd,
        env,
        docker,
        ensureReady: async () => {},
      }),
  };
}

function containerBackend(image: string): Backend | undefined {
  if (spawnSync(ENGINE, ["image", "inspect", image], { stdio: "ignore" }).status !== 0) {
    return undefined;
  }
  let container: string | undefined;
  const start = () => {
    container ??= `mikan-env-test-${randomUUID().slice(0, 8)}`;
    execFileSync(ENGINE, ["run", "-d", "--name", container, image, "sleep", "infinity"]);
    cleanups.push(() => removeContainer(container!));
    return container;
  };
  return {
    name: image,
    makeDir: () => {
      const name = container ?? start();
      return execFileSync(ENGINE, ["exec", name, "mktemp", "-d"]).toString().trim();
    },
    removeDir: (dir) => execFileSync(ENGINE, ["exec", container!, "rm", "-rf", dir]),
    env: (cwd, env) => new ContainerExecutionEnv({ container: container!, cwd, env }),
  };
}

const dockerUp = spawnSync(ENGINE, ["info"], { stdio: "ignore" }).status === 0;
const backends = [
  hostShimBackend(),
  ...(dockerUp
    ? ["docker.io/library/debian:trixie-slim", "docker.io/library/alpine:latest"].map(
        containerBackend,
      )
    : []),
].filter((backend): backend is Backend => backend !== undefined);

async function inDir<T>(backend: Backend, use: (dir: string) => Promise<T>): Promise<T> {
  const dir = backend.makeDir();
  try {
    return await use(dir);
  } finally {
    backend.removeDir(dir);
  }
}

for (const backend of backends) {
  registerEnvConformance(
    {
      describe,
      expect,
      it: (name, run, timeout) =>
        name.startsWith("watch") ? it.skip(name, run, timeout) : it(name, run, timeout),
    },
    `ContainerExecutionEnv conformance (${backend.name})`,
    (use) => inDir(backend, (dir) => use(backend.env(dir))),
  );

  describe(`ContainerExecutionEnv (${backend.name})`, () => {
    test("does not offer file watching", async () => {
      await inDir(backend, async (dir) => {
        const watched = await backend.env(dir).watch([{ path: dir }], () => {}, TEST_CONTEXT);
        expect(watched.ok ? "ok" : watched.error.code).toBe("not_supported");
      });
    });

    test("round-trips shell-hostile content and leaves no staging file", async () => {
      await inDir(backend, async (dir) => {
        const env = backend.env(dir);
        const content = `it's "$HOME" \`whoami\` 100%\n\\n not a newline\n橘子 🍊\n`;
        expect((await env.writeFile("config.sh", content, TEST_CONTEXT)).ok).toBe(true);
        expect(await env.readTextFile("config.sh", TEST_CONTEXT)).toEqual({
          ok: true,
          value: content,
        });
        const listed = await env.listDir(".", TEST_CONTEXT);
        expect(listed.ok && listed.value.map((entry) => entry.name)).toEqual(["config.sh"]);
      });
    });

    test("writes and appends large binary content", async () => {
      await inDir(backend, async (dir) => {
        const env = backend.env(dir);
        const initial = Uint8Array.from({ length: 300_000 }, (_, index) => index % 251);
        const appended = Uint8Array.from({ length: 70_000 }, (_, index) => 255 - (index % 251));
        expect((await env.writeFile("large.bin", initial, TEST_CONTEXT)).ok).toBe(true);
        expect((await env.appendFile("large.bin", appended, TEST_CONTEXT)).ok).toBe(true);
        const read = await env.readBinaryFile("large.bin", TEST_CONTEXT);
        expect(read.ok && Buffer.from(read.value)).toEqual(
          Buffer.concat([Buffer.from(initial), Buffer.from(appended)]),
        );
      });
    });

    test("injects credentials and the GitHub credential helper into commands", async () => {
      await inDir(backend, async (dir) => {
        let output = "";
        const result = await backend
          .env(dir, { GH_TOKEN: "token" })
          .exec(
            'printf "%s|%s" "$GH_TOKEN" "$GIT_CONFIG_VALUE_1"',
            { onOutput: (text) => (output += text) },
            TEST_CONTEXT,
          );
        expect(result.ok && result.value.exitCode).toBe(0);
        expect(output).toBe("token|!gh auth git-credential");
      });
    });

    test("spills output past the thresholds into the workspace", async () => {
      await inDir(backend, async (dir) => {
        const env = backend.env(dir);
        let streamed = "";
        const result = await env.exec(
          "i=1; while [ $i -le 5000 ]; do echo $i; i=$((i+1)); done",
          {
            spill: { afterLines: 10, afterBytes: 1_000_000 },
            onOutput: (text) => (streamed += text),
          },
          TEST_CONTEXT,
        );
        if (!result.ok) throw result.error;
        expect(result.value.spillPath).toMatch(
          new RegExp(`^${dir}/\\.mikan/bash-output/.+\\.log$`),
        );
        expect(streamed.trimEnd().split("\n").at(-1)).toBe("5000");
        expect(await env.readTextFile(result.value.spillPath!, TEST_CONTEXT)).toEqual({
          ok: true,
          value: streamed,
        });
      });
    });
  });
}

describe("ContainerExecutionEnv without a backend", () => {
  test("names one file namespace per container", () => {
    const first = new ContainerExecutionEnv({ container: "c", cwd: "/a", docker: "docker" });
    const second = new ContainerExecutionEnv({ container: "c", cwd: "/b", docker: "docker" });
    expect(first.id).toBe(second.id);
  });

  test("reports a missing docker CLI by its path", async () => {
    const docker = join(tmpdir(), `no-docker-${randomUUID()}`);
    const env = new ContainerExecutionEnv({
      container: "c",
      cwd: "/",
      docker,
      ensureReady: async () => {},
    });
    const result = await env.exec("true", undefined, TEST_CONTEXT);
    expect(result.ok ? "ok" : result.error.message).toContain(docker);
  });
});
