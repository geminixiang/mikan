import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const gondolin = vi.hoisted(() => ({
  create: vi.fn(),
  RealFSProvider: vi.fn(),
  ensureImageSelector: vi.fn(async (selector: string) => ({
    assetDir: `/images/${selector}`,
    buildId: selector,
  })),
}));

vi.mock("@earendil-works/gondolin", () => ({
  RealFSProvider: gondolin.RealFSProvider,
  ensureImageSelector: gondolin.ensureImageSelector,
  VM: { create: gondolin.create },
}));

import {
  GondolinExecutor,
  closeAllGondolinVms,
  gondolinResources,
  stopIdleGondolinVms,
} from "../src/sandbox/gondolin.js";
import { gondolinInventory } from "../src/sandbox/gondolin-inventory.js";

let vmCount = 0;

function createVm() {
  vmCount += 1;
  return {
    id: `vm-${vmCount}`,
    getHostPid: vi.fn().mockReturnValue(null),
    close: vi.fn().mockResolvedValue(undefined),
    exec: vi.fn().mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 }),
    fs: {
      mkdir: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue("content"),
      rename: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
    },
  };
}

function createExecutor(instanceId: string): GondolinExecutor {
  return new GondolinExecutor({
    type: "gondolin",
    profile: "default",
    instanceId,
    workspacePath: "/workspace-host",
  });
}

describe("Gondolin lifecycle", () => {
  const nodeVersion = Object.getOwnPropertyDescriptor(process.versions, "node");

  beforeEach(() => {
    gondolin.create.mockReset();
    gondolin.RealFSProvider.mockReset();
    gondolin.ensureImageSelector.mockClear();
    gondolinResources.configure();
    vmCount = 0;
    Object.defineProperty(process.versions, "node", { value: "24.0.0", configurable: true });
  });

  afterEach(async () => {
    await closeAllGondolinVms();
    if (nodeVersion) Object.defineProperty(process.versions, "node", nodeVersion);
    vi.restoreAllMocks();
  });

  test("closes an idle VM and recreates it on the next operation", async () => {
    const first = createVm();
    const second = createVm();
    gondolin.create.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const executor = createExecutor("idle");

    await executor.exec("pwd");
    await stopIdleGondolinVms(0, Date.now() + 1);
    expect(first.close).toHaveBeenCalledOnce();

    await executor.exec("pwd");
    expect(gondolin.create).toHaveBeenCalledTimes(2);
    expect(second.exec).toHaveBeenCalledOnce();
  });

  test("keeps an idle VM tracked when close fails", async () => {
    const first = createVm();
    first.close.mockRejectedValueOnce(new Error("close failed"));
    const second = createVm();
    gondolin.create.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const executor = createExecutor("idle-close-failure");

    await executor.exec("pwd");
    await stopIdleGondolinVms(0, Date.now() + 1);
    expect(first.close).toHaveBeenCalledOnce();

    await executor.exec("pwd");
    expect(first.close).toHaveBeenCalledTimes(2);
    expect(gondolin.create).toHaveBeenCalledTimes(2);
  });

  test("creates providers for each configured workspace mount", async () => {
    const vm = createVm();
    gondolin.create.mockResolvedValue(vm);
    const executor = new GondolinExecutor({
      type: "gondolin",
      profile: "default",
      instanceId: "mounts",
      mounts: [
        { source: "/host/MEMORY.md", target: "/workspace/MEMORY.md" },
        { source: "/host/C123", target: "/workspace/C123" },
      ],
    });

    await executor.exec("pwd");

    expect(gondolin.RealFSProvider).toHaveBeenCalledTimes(2);
    expect(gondolin.RealFSProvider).toHaveBeenNthCalledWith(1, "/host/C123");
    expect(gondolin.RealFSProvider).toHaveBeenNthCalledWith(2, "/host/MEMORY.md");
    expect(Object.keys(gondolin.create.mock.calls[0][0].vfs.mounts)).toEqual([
      "/workspace/C123",
      "/workspace/MEMORY.md",
    ]);
  });

  test("labels the session and tracks it in the runtime inventory", async () => {
    const vm = createVm();
    vm.getHostPid.mockReturnValue(777);
    gondolin.create.mockResolvedValue(vm);
    const record = vi.spyOn(gondolinInventory, "record");
    const release = vi.spyOn(gondolinInventory, "release");
    const executor = createExecutor("inventory");

    await executor.exec("pwd");
    expect(gondolin.create).toHaveBeenCalledWith(
      expect.objectContaining({ sessionLabel: "mikan:inventory" }),
    );
    expect(record).toHaveBeenCalledWith({
      sessionId: vm.id,
      instanceId: "inventory",
      runnerPid: 777,
    });

    await stopIdleGondolinVms(0, Date.now() + 1);
    expect(release).toHaveBeenCalledWith(vm.id);
  });

  test("serializes an idle close with a concurrent acquire", async () => {
    let finishClose!: () => void;
    const first = createVm();
    first.close.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishClose = resolve;
      }),
    );
    const second = createVm();
    gondolin.create.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const executor = createExecutor("serialized");

    await executor.exec("pwd");
    const closing = stopIdleGondolinVms(0, Date.now() + 1);
    const execution = executor.exec("pwd");
    await new Promise((resolve) => setImmediate(resolve));
    expect(gondolin.create).toHaveBeenCalledTimes(1);

    finishClose();
    await closing;
    await execution;
    expect(gondolin.create).toHaveBeenCalledTimes(2);
    expect(second.exec).toHaveBeenCalledOnce();
  });

  test("injects vault env into commands", async () => {
    const vm = createVm();
    gondolin.create.mockResolvedValue(vm);
    const executor = new GondolinExecutor(
      {
        type: "gondolin",
        profile: "default",
        instanceId: "env",
        workspacePath: "/workspace-host",
      },
      { GH_TOKEN: "secret" },
    );

    await executor.exec("git fetch");

    expect(vm.exec).toHaveBeenCalledWith(
      "if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then gh auth setup-git >/dev/null 2>&1 || true; fi\ngit fetch",
      {
        cwd: "/workspace",
        env: { GH_TOKEN: "secret" },
        signal: undefined,
      },
    );
  });

  test("applies limits and recreates the VM when boosted", async () => {
    const first = createVm();
    const second = createVm();
    gondolin.create.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    gondolinResources.configure({ cpus: "0.5", memory: "512m" }, { cpus: "2", memory: "2g" });
    const executor = new GondolinExecutor({
      type: "gondolin",
      profile: "default",
      instanceId: "limits",
      resourceKey: "c123",
      workspacePath: "/workspace-host",
    });

    await executor.exec("pwd");
    expect(gondolin.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ cpus: 1, memory: "512m" }),
    );

    await gondolinResources.boost("c123");
    await executor.exec("pwd");
    expect(first.close).toHaveBeenCalledOnce();
    expect(gondolin.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cpus: 2, memory: "2g" }),
    );
    expect(gondolinResources.getLimitStatus("c123").boosted).toBe(true);

    await closeAllGondolinVms();
    expect(gondolinResources.getLimitStatus("c123")).toEqual({
      limits: { cpus: "0.5", memory: "512m" },
      boosted: false,
    });
  });

  test("rejects an invalid CPU limit before creating a VM", async () => {
    gondolinResources.configure({ cpus: "invalid" });
    const executor = new GondolinExecutor({
      type: "gondolin",
      profile: "default",
      instanceId: "invalid-limits",
      resourceKey: "c123",
      workspacePath: "/workspace-host",
    });

    await expect(executor.exec("pwd")).rejects.toThrow(
      "Error: invalid Gondolin CPU limit 'invalid'",
    );
    expect(gondolin.create).not.toHaveBeenCalled();
  });

  test("does not close a VM while an operation is active", async () => {
    let finish!: (result: { stdout: string; stderr: string; exitCode: number }) => void;
    const vm = createVm();
    vm.exec.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    gondolin.create.mockResolvedValue(vm);
    const executor = createExecutor("active");

    const execution = executor.exec("sleep 1");
    await vi.waitFor(() => expect(vm.exec).toHaveBeenCalledOnce());
    await stopIdleGondolinVms(0, Date.now() + 1);
    expect(vm.close).not.toHaveBeenCalled();

    finish({ stdout: "", stderr: "", exitCode: 0 });
    await execution;
    await stopIdleGondolinVms(0, Date.now() + 1);
    expect(vm.close).toHaveBeenCalledOnce();
  });

  test("waits for active work before recreating a drifted runtime", async () => {
    let finish!: (result: { stdout: string; stderr: string; exitCode: number }) => void;
    const first = createVm();
    first.exec.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const second = createVm();
    gondolin.create.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const original = new GondolinExecutor({
      type: "gondolin",
      profile: "default",
      instanceId: "mount-drift",
      mounts: [{ source: "/host/C123", target: "/workspace/C123" }],
    });
    const changed = new GondolinExecutor({
      type: "gondolin",
      profile: "default",
      instanceId: "mount-drift",
      mounts: [{ source: "/host", target: "/workspace" }],
    });

    const active = original.exec("sleep 1");
    await vi.waitFor(() => expect(first.exec).toHaveBeenCalledOnce());
    const replacement = changed.exec("pwd");
    await Promise.resolve();
    expect(gondolin.create).toHaveBeenCalledTimes(1);
    expect(first.close).not.toHaveBeenCalled();

    finish({ stdout: "", stderr: "", exitCode: 0 });
    await active;
    await replacement;
    expect(first.close).toHaveBeenCalledOnce();
    expect(gondolin.create).toHaveBeenCalledTimes(2);
    expect(second.exec).toHaveBeenCalledOnce();
  });

  test("recreates once when the image identity changes", async () => {
    const first = createVm();
    const second = createVm();
    gondolin.create.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const original = new GondolinExecutor({
      type: "gondolin",
      profile: "default",
      instanceId: "image-drift",
      image: "mikan-sandbox:first",
      workspacePath: "/workspace-host",
    });
    const changed = new GondolinExecutor({
      type: "gondolin",
      profile: "default",
      instanceId: "image-drift",
      image: "mikan-sandbox:second",
      workspacePath: "/workspace-host",
    });

    await original.exec("pwd");
    await changed.exec("pwd");
    await changed.exec("pwd");

    expect(first.close).toHaveBeenCalledOnce();
    expect(gondolin.create).toHaveBeenCalledTimes(2);
    expect(gondolin.ensureImageSelector).toHaveBeenCalledWith("mikan-sandbox:second");
  });

  test("keeps a stale session tracked when drift cleanup fails", async () => {
    const first = createVm();
    first.close.mockRejectedValueOnce(new Error("close failed"));
    const second = createVm();
    gondolin.create.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const original = new GondolinExecutor({
      type: "gondolin",
      profile: "default",
      instanceId: "close-failure",
      image: "mikan-sandbox:first",
      workspacePath: "/workspace-host",
    });
    const changed = new GondolinExecutor({
      type: "gondolin",
      profile: "default",
      instanceId: "close-failure",
      image: "mikan-sandbox:second",
      workspacePath: "/workspace-host",
    });

    await original.exec("pwd");
    await expect(changed.exec("pwd")).rejects.toThrow("close failed");
    expect(gondolin.create).toHaveBeenCalledTimes(1);

    await changed.exec("pwd");
    expect(first.close).toHaveBeenCalledTimes(2);
    expect(gondolin.create).toHaveBeenCalledTimes(2);
  });

  test("recreates a session after VM startup fails", async () => {
    const vm = createVm();
    gondolin.create.mockRejectedValueOnce(new Error("boot failed")).mockResolvedValueOnce(vm);
    const executor = createExecutor("retry");

    await expect(executor.exec("pwd")).rejects.toThrow("boot failed");
    await expect(executor.exec("pwd")).resolves.toEqual({ stdout: "ok", stderr: "", code: 0 });
    expect(gondolin.create).toHaveBeenCalledTimes(2);
  });

  test("closes all sessions during shutdown", async () => {
    const first = createVm();
    const second = createVm();
    gondolin.create.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    await createExecutor("one").exec("pwd");
    await createExecutor("two").exec("pwd");
    await closeAllGondolinVms();

    expect(first.close).toHaveBeenCalledOnce();
    expect(second.close).toHaveBeenCalledOnce();
  });

  test("waits for active operations before closing during shutdown", async () => {
    let finish!: (result: { stdout: string; stderr: string; exitCode: number }) => void;
    const vm = createVm();
    vm.exec.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    gondolin.create.mockResolvedValue(vm);

    const execution = createExecutor("shutdown-active").exec("sleep 1");
    await vi.waitFor(() => expect(vm.exec).toHaveBeenCalledOnce());
    const closing = closeAllGondolinVms();
    expect(vm.close).not.toHaveBeenCalled();
    await expect(createExecutor("late").exec("pwd")).rejects.toThrow(
      "Error: Gondolin runtime is shutting down",
    );

    finish({ stdout: "", stderr: "", exitCode: 0 });
    await execution;
    await closing;
    expect(vm.close).toHaveBeenCalledOnce();
  });

  test("rejects an acquisition that was resolving during shutdown", async () => {
    let finishResolve!: (image: { assetDir: string; buildId: string }) => void;
    gondolin.ensureImageSelector.mockReturnValueOnce(
      new Promise((resolve) => {
        finishResolve = resolve;
      }),
    );
    const execution = createExecutor("resolving").exec("pwd");
    await vi.waitFor(() => expect(gondolin.ensureImageSelector).toHaveBeenCalledOnce());

    await closeAllGondolinVms();
    finishResolve({ assetDir: "/images/mikan", buildId: "mikan" });

    await expect(execution).rejects.toThrow("Error: Gondolin runtime is shutting down");
    expect(gondolin.create).not.toHaveBeenCalled();
  });
});
