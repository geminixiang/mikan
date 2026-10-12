import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { isRecord } from "../unknown-values.js";
import { DockerContainerManager } from "./provisioner.js";
import type {
  BrowserOwner,
  DesktopProcess,
  DesktopStart,
  DesktopStatus,
  DesktopStream,
  DockerExecFile,
} from "./types.js";

export const DESKTOP_COMMAND = "mikan-desktop";

export const DESKTOP_RUNTIME_DIR = "/run/user/0";

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

export function parseDesktopStatus(stdout: string): DesktopStatus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { display: undefined, control: "agent" };
  }
  if (!isRecord(parsed)) return { display: undefined, control: "agent" };
  const display = typeof parsed.display === "string" && parsed.display ? parsed.display : undefined;
  return { display, control: parsed.control === "user" ? "user" : "agent" };
}

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

  async status(containerKey: string): Promise<DesktopStatus> {
    const { stdout } = await this.desktopCommand(containerKey, ["status"]);
    return parseDesktopStatus(stdout);
  }

  async setBrowserOwner(containerKey: string, owner: BrowserOwner): Promise<void> {
    await this.desktopCommand(containerKey, ["control", owner]);
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
