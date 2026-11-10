import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { isRecord } from "../unknown-values.js";
import { DockerContainerManager } from "./provisioner.js";
import type { DesktopProcess, DesktopStart, DesktopStream, DockerExecFile } from "./types.js";

const DESKTOP_COMMAND = "mikan-desktop";

type DesktopContainers = Pick<DockerContainerManager, "engine" | "retain" | "isRunning">;

interface DesktopProcessRunners {
  execFile?: DockerExecFile;
  spawn?: (
    file: string,
    args: string[],
    options: { stdio: ["pipe", "pipe", "ignore"] },
  ) => DesktopProcess;
}

const MISSING_COMMAND = /executable file not found|not found in \$PATH/i;

const DESKTOP_EXEC_TIMEOUT_MS = 20_000;

const execFileAsync = promisify(execFile);

export class OfficeDesktop {
  private readonly execFile: NonNullable<DesktopProcessRunners["execFile"]>;
  private readonly spawn: NonNullable<DesktopProcessRunners["spawn"]>;

  constructor(
    private readonly containers: DesktopContainers,
    runners: DesktopProcessRunners = {},
  ) {
    this.execFile =
      runners.execFile ??
      ((file, args) => execFileAsync(file, args, { timeout: DESKTOP_EXEC_TIMEOUT_MS }));
    this.spawn = runners.spawn ?? spawn;
  }

  async start(containerKey: string): Promise<DesktopStart> {
    if (!this.containers.isRunning(containerKey)) return "stopped";
    try {
      await this.desktopCommand(containerKey, ["start"]);
      return "ready";
    } catch (error) {
      const output = isRecord(error)
        ? `${String(error.stdout ?? "")}\n${String(error.stderr ?? "")}`
        : "";
      if (MISSING_COMMAND.test(output)) {
        return "outdated-image";
      }
      throw error;
    }
  }

  connect(containerKey: string): DesktopStream {
    const container = DockerContainerManager.containerName(containerKey);
    const child = this.spawn(
      this.containers.engine,
      ["exec", "-i", container, DESKTOP_COMMAND, "connect"],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    const retained = this.containers.retain(containerKey);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      retained();
    };
    const close = () => {
      release();
      child.kill();
    };
    child.once("exit", release);
    child.once("error", release);
    if (!child.stdin || !child.stdout) {
      close();
      throw new Error(`${this.containers.engine} exec for ${container} has no stdio`);
    }
    return { input: child.stdin, output: child.stdout, process: child, close };
  }

  private desktopCommand(containerKey: string, args: string[]): Promise<{ stdout: string }> {
    return this.execFile(this.containers.engine, [
      "exec",
      DockerContainerManager.containerName(containerKey),
      DESKTOP_COMMAND,
      ...args,
    ]);
  }
}
