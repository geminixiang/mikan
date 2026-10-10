import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, test } from "vitest";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { registerEnvConformance } from "@earendil-works/pi-durable/testing";
import { createContainerExecutionEnv } from "../sandbox/container.js";
import type { ContainerExecutionEnvOptions } from "../sandbox/types.js";
import { TEST_CONTEXT } from "./tool-api.js";
import { containerEngine } from "../sandbox/engine.js";

const ENGINE = containerEngine();

function removeContainer(name: string): void {
  spawnSync(ENGINE, ["kill", name], { stdio: "ignore" });
  spawnSync(ENGINE, ["rm", "-f", name], { stdio: "ignore" });
}

type EnvOverrides = Partial<Omit<ContainerExecutionEnvOptions, "cwd">>;

interface Backend {
  name: string;
  makeDir(): string;
  removeDir(dir: string): void;
  env(cwd: string, overrides?: EnvOverrides): ExecutionEnv;
}

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function hostShimBackend(): Backend | undefined {
  if (process.platform !== "linux") return undefined;
  const shimDir = mkdtempSync(join(tmpdir(), "mikan-docker-shim-"));
  cleanups.push(() => rmSync(shimDir, { recursive: true, force: true }));
  const engine = join(shimDir, "docker");
  writeFileSync(
    engine,
    [
      "#!/bin/sh",
      '[ "$1" = exec ] || exit 2; shift',
      '[ "$1" = -i ] && shift',
      'shift; exec "$@"',
    ].join("\n"),
  );
  chmodSync(engine, 0o755);
  const container = `shim-${randomUUID().slice(0, 8)}`;
  return {
    name: "host shim",
    makeDir: () => mkdtempSync(join(tmpdir(), "mikan-container-env-")),
    removeDir: (dir) => rmSync(dir, { recursive: true, force: true }),
    env: (cwd, overrides) =>
      createContainerExecutionEnv({
        container,
        cwd,
        engine,
        ensureReady: async () => {},
        ...overrides,
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
    env: (cwd, overrides) =>
      createContainerExecutionEnv({ container: container!, cwd, engine: ENGINE, ...overrides }),
  };
}

const engineUp = spawnSync(ENGINE, ["info"], { stdio: "ignore" }).status === 0;
const backends = [
  hostShimBackend(),
  ...(engineUp
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
    { describe, expect, it },
    `container ExecutionEnv conformance (${backend.name})`,
    (use) => inDir(backend, (dir) => use(backend.env(dir))),
  );

  describe(`container ExecutionEnv (${backend.name})`, () => {
    test("injects credentials and the GitHub credential helper into commands", async () => {
      await inDir(backend, async (dir) => {
        let output = "";
        const result = await backend
          .env(dir, { env: { GH_TOKEN: "token" } })
          .exec(
            'printf "%s|%s" "$GH_TOKEN" "$GIT_CONFIG_VALUE_1"',
            { onOutput: (text) => (output += text) },
            TEST_CONTEXT,
          );
        expect(result.ok && result.value.exitCode).toBe(0);
        expect(output).toBe("token|!gh auth git-credential");
      });
    });

    test("readies the runtime once per environment and marks every operation as use", async () => {
      await inDir(backend, async (dir) => {
        let readied = 0;
        let used = 0;
        const env = backend.env(dir, {
          ensureReady: async () => void readied++,
          markUsed: () => void used++,
        });

        await env.writeFile("a.txt", "a", TEST_CONTEXT);
        await env.readTextFile("a.txt", TEST_CONTEXT);
        await env.exec("true", undefined, TEST_CONTEXT);

        expect(readied).toBe(1);
        expect(used).toBe(3);
      });
    });

    test("a runtime that cannot be readied fails the operation as a result", async () => {
      await inDir(backend, async (dir) => {
        const env = backend.env(dir, {
          ensureReady: async () => {
            throw new Error("provisioning failed");
          },
        });

        const read = await env.readTextFile("a.txt", TEST_CONTEXT);
        const exec = await env.exec("true", undefined, TEST_CONTEXT);

        expect(read.ok ? "ok" : read.error.message).toContain("provisioning failed");
        expect(exec.ok ? "ok" : exec.error.message).toContain("provisioning failed");
      });
    });
  });
}

describe("container ExecutionEnv without a backend", () => {
  test("names one file namespace per container", () => {
    const first = createContainerExecutionEnv({ container: "c", cwd: "/a", engine: "docker" });
    const second = createContainerExecutionEnv({ container: "c", cwd: "/b", engine: "docker" });
    expect(first.id).toBe(second.id);
  });

  test("reports a missing engine CLI by its path", async () => {
    const engine = join(tmpdir(), `no-engine-${randomUUID()}`);
    const env = createContainerExecutionEnv({
      container: "c",
      cwd: "/",
      engine,
      ensureReady: async () => {},
    });
    const result = await env.exec("true", undefined, TEST_CONTEXT);
    expect(result.ok ? "ok" : result.error.message).toContain(engine);
  });
});
