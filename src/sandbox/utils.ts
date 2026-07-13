import { spawn } from "child_process";

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
    } catch {
      // Ignore errors
    }
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Process already dead
      }
    }
  }
}

export function shellEscape(s: string): string {
  // Escape for passing to sh -c
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Shared exec-backed file transport for executors whose only channel into the
 * runtime is `exec` (docker exec, ssh, HTTP). Contents travel base64-encoded —
 * the base64 alphabet is inert under every shell parse layer — and writes are
 * chunked so no single command approaches the per-argument ARG_MAX limit,
 * staged, then moved into place so an aborted write never truncates the file.
 */
const WRITE_CHUNK_CHARS = 65536;

interface ExecLikeResult {
  stdout: string;
  stderr: string;
  code: number;
}

interface ExecLike<TOptions> {
  exec(command: string, options?: TOptions): Promise<ExecLikeResult>;
}

export async function execReadFile<TOptions>(
  executor: ExecLike<TOptions>,
  path: string,
  options?: TOptions,
): Promise<string> {
  const result = await executor.exec(`base64 < ${shellEscape(path)}`, options);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `Failed to read file: ${path}`);
  }
  return Buffer.from(result.stdout.replace(/\s+/g, ""), "base64").toString("utf-8");
}

export async function execWriteFile<TOptions>(
  executor: ExecLike<TOptions>,
  path: string,
  content: string,
  options?: TOptions,
): Promise<void> {
  const encoded = Buffer.from(content, "utf-8").toString("base64");
  const escapedPath = shellEscape(path);
  const stage = shellEscape(`${path}.mikan-stage`);
  const stageB64 = shellEscape(`${path}.mikan-stage.b64`);

  const run = async (command: string) => {
    const result = await executor.exec(command, options);
    if (result.code !== 0) {
      await executor.exec(`rm -f ${stage} ${stageB64}`, options).catch(() => {});
      throw new Error(result.stderr.trim() || `Failed to write file: ${path}`);
    }
  };

  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) || "/" : ".";
  await run(`mkdir -p ${shellEscape(dir)} && : > ${stageB64}`);
  for (let offset = 0; offset === 0 || offset < encoded.length; offset += WRITE_CHUNK_CHARS) {
    const chunk = encoded.slice(offset, offset + WRITE_CHUNK_CHARS);
    await run(`printf '%s' ${shellEscape(chunk)} >> ${stageB64}`);
  }
  await run(
    `base64 -d < ${stageB64} > ${stage} && mv ${stage} ${escapedPath} && rm -f ${stageB64}`,
  );
}
