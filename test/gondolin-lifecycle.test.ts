import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const gondolin = vi.hoisted(() => ({ create: vi.fn(), RealFSProvider: vi.fn() }));

vi.mock("@earendil-works/gondolin", () => ({
  RealFSProvider: gondolin.RealFSProvider,
  VM: { create: gondolin.create },
}));

import {
  GondolinExecutor,
  closeAllGondolinVms,
  gondolinResources,
  stopIdleGondolinVms,
} from "../src/sandbox/gondolin.js";

function createVm() {
  return {
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
    gondolinResources.configure();
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
    expect(gondolin.RealFSProvider).toHaveBeenNthCalledWith(1, "/host/MEMORY.md");
    expect(gondolin.RealFSProvider).toHaveBeenNthCalledWith(2, "/host/C123");
    expect(Object.keys(gondolin.create.mock.calls[0][0].vfs.mounts)).toEqual([
      "/workspace/MEMORY.md",
      "/workspace/C123",
    ]);
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

    finish({ stdout: "", stderr: "", exitCode: 0 });
    await execution;
    await closing;
    expect(vm.close).toHaveBeenCalledOnce();
  });
});
