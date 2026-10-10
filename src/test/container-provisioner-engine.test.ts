import { execFile, execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test, vi } from "vitest";
import * as log from "../log.js";
import { containerEngine } from "../sandbox/engine.js";
import { DockerContainerManager } from "../sandbox/provisioner.js";

const ENGINE = containerEngine();
const IMAGE = "docker.io/library/debian:trixie-slim";
const available = spawnSync(ENGINE, ["image", "inspect", IMAGE], { stdio: "ignore" }).status === 0;

const root = available ? mkdtempSync(join(homedir(), ".mikan-engine-test-")) : "";
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function inContainer(name: string, command: string): string {
  return execFileSync(ENGINE, ["exec", name, "sh", "-c", command]).toString().trim();
}

describe.runIf(available)(`DockerContainerManager on ${ENGINE}`, () => {
  test("keeps, restarts, limits, adopts, and removes a container without needless replacement", async () => {
    const office = join(root, "office");
    mkdirSync(office);
    writeFileSync(join(root, "MEMORY.md"), "memory");
    const mounts = [
      { source: office, target: "/workspace/office" },
      { source: join(root, "MEMORY.md"), target: "/workspace/MEMORY.md", readOnly: true },
    ];
    const key = `engine-test-${randomUUID().slice(0, 8)}`;
    const name = DockerContainerManager.containerName(key);
    const sandbox = new DockerContainerManager(IMAGE, {
      limits: { cpus: "1", memory: "256m" },
      boostLimits: { cpus: "2", memory: "512m" },
      execFileImpl: promisify(execFile),
    });
    const logs = vi.spyOn(log, "logInfo").mockImplementation(() => {});
    try {
      await sandbox.provision(key, { mounts });
      inContainer(name, "echo kept > /root/marker");
      await sandbox.provision(key, { mounts });
      expect(inContainer(name, "cat /root/marker")).toBe("kept");

      await sandbox.boost(key);
      expect(inContainer(name, "cat /sys/fs/cgroup/cpu.max")).toBe("200000 100000");

      await sandbox.stop(key);
      await sandbox.provision(key, { mounts });
      expect(inContainer(name, "cat /root/marker")).toBe("kept");
      expect(logs).not.toHaveBeenCalledWith(expect.stringContaining("out of date"));

      await sandbox.reconcile(root);
      await sandbox.remove(key);
      const left = execFileSync(ENGINE, ["ps", "-a", "--filter", `name=^${name}$`, "-q"]);
      expect(left.toString().trim()).toBe("");
    } finally {
      spawnSync(ENGINE, ["kill", name], { stdio: "ignore" });
      spawnSync(ENGINE, ["rm", "-f", name], { stdio: "ignore" });
      spawnSync(ENGINE, ["network", "rm", DockerContainerManager.networkName(key)], {
        stdio: "ignore",
      });
    }
  }, 180_000);
});
