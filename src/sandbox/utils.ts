import { spawn } from "node:child_process";
import { isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import type { RuntimePathContext } from "./types.js";

export function execSimple(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += d;
    });
    child.stderr?.on("data", (d) => {
      stderr += d;
    });
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `Exit code ${code}`));
    });
  });
}

export function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        detached: true,
      });
    } catch {}
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
}

export function linkAbortSignal(signal: AbortSignal | undefined, onAbort: () => void): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    onAbort();
    return () => {};
  }
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

export function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

const FILE_TRANSPORT_CHUNK_CHARS = 65_536;

interface ExecLikeResult {
  stdout: string;
  stderr: string;
  code: number;
}

interface ExecLike<TOptions> {
  exec(command: string, options?: TOptions): Promise<ExecLikeResult>;
}

export async function execReadFileBase64<TOptions>(
  executor: ExecLike<TOptions>,
  path: string,
  options?: TOptions,
): Promise<string> {
  const result = await executor.exec(`base64 < ${shellEscape(path)}`, options);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `Failed to read file: ${path}`);
  }
  return result.stdout.replace(/\s+/g, "");
}

export async function execReadFile<TOptions>(
  executor: ExecLike<TOptions>,
  path: string,
  options?: TOptions,
): Promise<string> {
  return Buffer.from(await execReadFileBase64(executor, path, options), "base64").toString("utf-8");
}

export async function execWriteFile<TOptions>(
  executor: ExecLike<TOptions>,
  path: string,
  content: string | Uint8Array,
  options?: TOptions,
): Promise<void> {
  const encoded = Buffer.from(content).toString("base64");
  const escapedPath = shellEscape(path);
  const stage = shellEscape(`${path}.mikan-stage`);
  const stageB64Path = `${path}.mikan-stage.b64`;
  const stageB64 = shellEscape(stageB64Path);
  const run = createFileTransportRunner(executor, path, [stage, stageB64], options);

  await prepareBase64Stage(run, path, stageB64Path, encoded);
  await run(
    `base64 -d < ${stageB64} > ${stage} && mv ${stage} ${escapedPath} && rm -f ${stageB64}`,
  );
}

export async function execAppendFile<TOptions>(
  executor: ExecLike<TOptions>,
  path: string,
  content: string | Uint8Array,
  options?: TOptions,
): Promise<void> {
  const encoded = Buffer.from(content).toString("base64");
  const stagePath = `${path}.mikan-append.b64`;
  const stage = shellEscape(stagePath);
  const run = createFileTransportRunner(executor, path, [stage], options);

  await prepareBase64Stage(run, path, stagePath, encoded);
  await run(`base64 -d < ${stage} >> ${shellEscape(path)} && rm -f ${stage}`);
}

function createFileTransportRunner<TOptions>(
  executor: ExecLike<TOptions>,
  path: string,
  cleanupPaths: string[],
  options: TOptions | undefined,
): (command: string) => Promise<void> {
  return async (command) => {
    const result = await executor.exec(command, options);
    if (result.code === 0) return;
    await executor.exec(`rm -f ${cleanupPaths.join(" ")}`, options).catch(() => {});
    throw new Error(result.stderr.trim() || `Failed to write file: ${path}`);
  };
}

async function prepareBase64Stage(
  run: (command: string) => Promise<void>,
  path: string,
  stagePath: string,
  encoded: string,
): Promise<void> {
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) || "/" : ".";
  const stage = shellEscape(stagePath);
  await run(`mkdir -p ${shellEscape(dir)} && : > ${stage}`);
  for (
    let offset = 0;
    offset === 0 || offset < encoded.length;
    offset += FILE_TRANSPORT_CHUNK_CHARS
  ) {
    const chunk = encoded.slice(offset, offset + FILE_TRANSPORT_CHUNK_CHARS);
    await run(`printf '%s' ${shellEscape(chunk)} >> ${stage}`);
  }
}

export function createMountedRuntimePathContext(
  hostWorkspaceRoot: string,
  runtimeWorkspaceRoot: string,
): RuntimePathContext {
  return {
    hostWorkspaceRoot,
    runtimeWorkspaceRoot,
    runtimeToHostPath: (runtimePath) =>
      translateMountedRuntimePathToHost(runtimePath, runtimeWorkspaceRoot, hostWorkspaceRoot),
  };
}

function translateMountedRuntimePathToHost(
  runtimePath: string,
  runtimeWorkspaceRoot: string,
  hostWorkspaceRoot: string,
): string {
  if (!isAbsolute(runtimePath)) {
    return runtimePath;
  }

  const runtimeRoot = resolvePath(runtimeWorkspaceRoot);
  const normalizedRuntimePath = resolvePath(runtimePath);
  const runtimeRelativePath = relative(runtimeRoot, normalizedRuntimePath);
  const escapesRuntimeRoot =
    runtimeRelativePath === ".." ||
    runtimeRelativePath.startsWith(`..${sep}`) ||
    isAbsolute(runtimeRelativePath);

  if (escapesRuntimeRoot) {
    return runtimePath;
  }

  const hostRoot = resolvePath(hostWorkspaceRoot);
  const hostPath = resolvePath(hostRoot, runtimeRelativePath);
  const hostRelativePath = relative(hostRoot, hostPath);
  const escapesHostRoot =
    hostRelativePath === ".." ||
    hostRelativePath.startsWith(`..${sep}`) ||
    isAbsolute(hostRelativePath);

  return escapesHostRoot ? runtimePath : hostPath;
}

export class SandboxError extends Error {
  readonly details: string[];

  constructor(message: string, details?: string[]) {
    super(message);
    this.name = "SandboxError";
    this.details = details ?? [];
  }

  formatForCli(): string[] {
    return [this.message, ...this.details];
  }
}
