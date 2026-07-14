import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const gondolin = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("@earendil-works/gondolin", () => ({
  RealFSProvider: vi.fn(),
  VM: { create: gondolin.create },
}));

import {
  GondolinExecutor,
  closeAllGondolinVms,
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
