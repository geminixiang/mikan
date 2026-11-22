import { execFile, execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test, vi } from "vitest";
import { BackgroundJobs } from "../events/jobs.js";
import { createBashBackgroundTool } from "../harness/tools/bash-background.js";
import * as log from "../log.js";
import { createOfficeAddress, createWorkspace } from "../office/index.js";
import { createContainerExecutionEnv } from "../sandbox/container.js";
import { containerEngine } from "../sandbox/engine.js";
import { DockerContainerManager } from "../sandbox/provisioner.js";
import type { ConversationEvent, MessagingBot } from "../types.js";
import { runTestTool } from "./tool-api.js";

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
      execFileImpl: promisify(execFile),
    });
    const logs = vi.spyOn(log, "logInfo").mockImplementation(() => {});
    try {
      await sandbox.provision(key, { mounts });
      inContainer(name, "echo written > /workspace/office/from-sandbox");
      expect(readFileSync(join(office, "from-sandbox"), "utf8").trim()).toBe("written");
      expect(inContainer(name, "cat /workspace/MEMORY.md")).toBe("memory");
      inContainer(name, "echo kept > /root/marker");
      await sandbox.provision(key, { mounts });
      expect(inContainer(name, "cat /root/marker")).toBe("kept");

      await sandbox.setLimits(key, { cpus: "2", memory: "512m" });
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

  test("a background job runs in the office's container, is read from the host, and is killed at its limit", async () => {
    const workspace = createWorkspace({
      root: join(root, "jobs-workspace"),
      stateDir: join(root, "jobs-state"),
    });
    mkdirSync(workspace.root, { recursive: true });
    const conversationId = `DBGJOB${randomUUID().slice(0, 6).toUpperCase()}`;
    const office = workspace.office(createOfficeAddress("slack", conversationId));
    office.ensure();
    const name = DockerContainerManager.containerName(office.key);
    const sandbox = new DockerContainerManager(IMAGE, { execFileImpl: promisify(execFile) });
    let now = Date.now();
    const enqueueEvent = vi.fn<(event: ConversationEvent) => boolean>().mockReturnValue(true);
    const jobs = new BackgroundJobs(
      workspace,
      { slack: { enqueueEvent } as Pick<MessagingBot, "enqueueEvent"> as MessagingBot },
      { containers: sandbox, limitMs: 60_000, now: () => now },
    );
    const sleeping = () =>
      Number(inContainer(name, "cat /proc/[0-9]*/comm 2>/dev/null | grep -c '^sleep$' || true"));
    const logs = vi.spyOn(log, "logInfo").mockImplementation(() => {});
    try {
      await sandbox.provision(office.key, {
        mounts: [{ source: office.dir, target: `/workspace/${office.key}` }],
      });
      const env = createContainerExecutionEnv({
        container: name,
        cwd: "/workspace",
        engine: ENGINE,
      });
      const { tool, setRunContext } = createBashBackgroundTool({ env: () => env }, jobs, office);
      setRunContext({
        sessionKey: conversationId,
        threadTs: undefined,
        userId: "U1",
        conversationKind: "direct",
        runtimeWorkspaceRoot: "/workspace",
      });

      await runTestTool(
        tool,
        { label: "quick", command: "echo from-job; exit 4" },
        { memos: new Map() },
      );
      await vi.waitFor(
        async () => {
          jobs.poll();
          expect(enqueueEvent).toHaveBeenCalledTimes(1);
        },
        { timeout: 20_000, interval: 100 },
      );
      expect(enqueueEvent.mock.calls[0]![0]).toMatchObject({ sessionKey: conversationId });
      expect(enqueueEvent.mock.calls[0]![0].text).toMatch(
        /^\[job \w+ exited 4 after \d+s\] echo from-job; exit 4\nIts output is in \/workspace\/\S+\/log; read it with bash\.$/,
      );

      const idle = sleeping();
      await runTestTool(
        tool,
        { label: "slow", command: "sleep 300 & sleep 301" },
        { memos: new Map() },
      );
      await vi.waitFor(() => expect(sleeping()).toBe(idle + 2), { timeout: 10_000, interval: 100 });
      now += 60_000;
      jobs.poll();

      expect(enqueueEvent).toHaveBeenCalledTimes(2);
      expect(enqueueEvent.mock.calls[1]![0].text).toMatch(/ended without an exit code/);
      await vi.waitFor(() => expect(sleeping()).toBe(idle), { timeout: 10_000, interval: 100 });
    } finally {
      logs.mockRestore();
      spawnSync(ENGINE, ["kill", name], { stdio: "ignore" });
      spawnSync(ENGINE, ["rm", "-f", name], { stdio: "ignore" });
      spawnSync(ENGINE, ["network", "rm", DockerContainerManager.networkName(office.key)], {
        stdio: "ignore",
      });
    }
  }, 180_000);
});
