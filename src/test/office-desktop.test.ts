import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import { OfficeDesktop, parseDesktopStatus } from "../sandbox/desktop.js";

function commandError(stderr: string, code: number): Error {
  return Object.assign(new Error(`Command failed\n${stderr}`), { code, stderr });
}

function desktop(execFile = vi.fn(async () => ({ stdout: "" }))) {
  const release = vi.fn();
  const containers = {
    engine: "docker",
    retain: vi.fn(() => release),
    isRunning: vi.fn(() => true),
  };
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    kill: vi.fn(),
  });
  const spawn = vi.fn(() => child);
  return {
    office: new OfficeDesktop(containers, { execFile, spawn }),
    containers,
    release,
    execFile,
    spawn,
    child,
  };
}

describe("OfficeDesktop", () => {
  test("start runs the image's desktop command in the office container", async () => {
    const { office, execFile } = desktop();

    await expect(office.start("v1-slack-d1-abc")).resolves.toBe("ready");

    expect(execFile).toHaveBeenCalledWith("docker", [
      "exec",
      "mikan-sandbox-v1-slack-d1-abc",
      "mikan-desktop",
      "start",
    ]);
  });

  test.each(["stderr", "stdout"])(
    "start reports an image without the desktop, as the engine prints it on %s",
    async (stream) => {
      const message =
        'OCI runtime exec failed: exec: "mikan-desktop": executable file not found in $PATH';
      const execFile = vi.fn(async () => {
        throw Object.assign(commandError("", 127), { stderr: "", stdout: "", [stream]: message });
      });
      const { office } = desktop(execFile);

      await expect(office.start("v1-slack-d1-abc")).resolves.toBe("outdated-image");
    },
  );

  test("start refuses a container that is not running", async () => {
    const { office, containers, execFile } = desktop();
    containers.isRunning.mockReturnValue(false);

    await expect(office.start("v1-slack-d1-abc")).resolves.toBe("stopped");
    expect(execFile).not.toHaveBeenCalled();
  });

  test("setBrowserOwner writes who controls the browser", async () => {
    const { office, execFile } = desktop();

    await office.setBrowserOwner("v1-slack-d1-abc", "user");

    expect(execFile).toHaveBeenCalledWith("docker", [
      "exec",
      "mikan-sandbox-v1-slack-d1-abc",
      "mikan-desktop",
      "control",
      "user",
    ]);
  });

  test("connect streams through engine exec and retains the container until it closes", () => {
    const { office, containers, release, spawn, child } = desktop();

    const stream = office.connect("v1-slack-d1-abc");

    expect(spawn).toHaveBeenCalledWith(
      "docker",
      ["exec", "-i", "mikan-sandbox-v1-slack-d1-abc", "mikan-desktop", "connect"],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    expect(containers.retain).toHaveBeenCalledWith("v1-slack-d1-abc");
    expect(stream.output).toBe(child.stdout);
    expect(release).not.toHaveBeenCalled();

    child.emit("exit", 0);
    stream.close();
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("parseDesktopStatus", () => {
  test.each([
    ['{"display":"wayland-1","control":"user"}', { display: "wayland-1", control: "user" }],
    ['{"display":"","control":"agent"}', { display: undefined, control: "agent" }],
    ["not json", { display: undefined, control: "agent" }],
    ['{"display":"x","control":"root"}', { display: "x", control: "agent" }],
  ])("%s", (stdout, expected) => {
    expect(parseDesktopStatus(stdout)).toEqual(expected);
  });
});
