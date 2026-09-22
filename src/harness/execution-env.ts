import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  ExecutionError,
  FileError,
  err,
  ok,
  truncateHead,
  truncateTail,
  type Context,
  type ExecutionEnv,
  type FileInfo,
  type FileKind,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  type ShellOutputMetadata,
  type TruncationResult,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { Executor, SandboxConfig } from "../sandbox/index.js";
import { execAppendFile, execWriteFile, shellEscape } from "../sandbox/utils.js";

const SPILL_DIR = ".mikan/bash-output";

export function createSandboxExecutionEnv(
  executor: Executor,
  sandboxType: SandboxConfig["type"],
  runtimeWorkspaceRoot: string,
): ExecutionEnv {
  if (sandboxType === "host") {
    return new NodeExecutionEnv({ cwd: runtimeWorkspaceRoot });
  }
  return new ShellExecutionEnv(executor, runtimeWorkspaceRoot);
}

type TextLineReader =
  Awaited<ReturnType<ExecutionEnv["openTextLineReader"]>> extends Result<infer T, FileError>
    ? T
    : never;
type TextLine =
  Awaited<ReturnType<TextLineReader["readLine"]>> extends Result<infer T, FileError>
    ? Exclude<T, undefined>
    : never;

class ShellExecutionEnv implements ExecutionEnv {
  readonly cwd: string;

  constructor(
    private readonly executor: Executor,
    runtimeWorkspaceRoot: string,
  ) {
    this.cwd = runtimeWorkspaceRoot;
  }

  async absolutePath(path: string, _context: Context): Promise<Result<string, FileError>> {
    return ok(posix.isAbsolute(path) ? posix.normalize(path) : posix.resolve(this.cwd, path));
  }

  async joinPath(parts: string[], _context: Context): Promise<Result<string, FileError>> {
    return ok(posix.join(...parts));
  }

  readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.fileOp(() => this.executor.readFile(path, this.execOptions(context)));
  }

  openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
    return this.fileOp(async () => {
      const content = await this.executor.readFile(path, this.execOptions(context));
      return new ShellTextLineReader(content);
    });
  }

  async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    return this.fileOp(async () =>
      Buffer.from(await this.executor.readFileBase64(path, this.execOptions(context)), "base64"),
    );
  }

  readTextLines(
    path: string,
    options: { maxLines?: number } | undefined,
    context: Context,
  ): Promise<Result<string[], FileError>> {
    return this.fileOp(async () => {
      const max = options?.maxLines;
      const command =
        max === undefined
          ? `cat ${shellEscape(path)}`
          : `head -n ${Math.max(0, Math.floor(max))} ${shellEscape(path)}`;
      const { stdout } = await this.run(command, context);
      const lines = stdout.split("\n");
      if (lines.at(-1) === "") lines.pop();
      return lines;
    });
  }

  writeFile(
    path: string,
    content: string | Uint8Array,
    context: Context,
  ): Promise<Result<void, FileError>> {
    return this.fileOp(() =>
      execWriteFile(this.executor, path, content, this.execOptions(context)),
    );
  }

  appendFile(
    path: string,
    content: string | Uint8Array,
    context: Context,
  ): Promise<Result<void, FileError>> {
    return this.fileOp(() =>
      execAppendFile(this.executor, path, content, this.execOptions(context)),
    );
  }

  renameFile(
    sourcePath: string,
    destinationPath: string,
    context: Context,
  ): Promise<Result<void, FileError>> {
    return this.fileOp(async () => {
      await this.run(`mv -f ${shellEscape(sourcePath)} ${shellEscape(destinationPath)}`, context);
    });
  }

  fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    return this.fileOp(async () => {
      const escaped = shellEscape(path);
      const probe = await this.executor.exec(
        `if [ -L ${escaped} ]; then printf 'symlink'; elif [ -d ${escaped} ]; then printf 'directory'; ` +
          `elif [ -f ${escaped} ]; then printf 'file'; else exit 1; fi`,
        this.execOptions(context),
      );
      if (probe.code !== 0) throw new Error(`No such file or directory: ${path}`);
      const kind = probe.stdout.trim() as FileKind;
      let size = 0;
      if (kind === "file") {
        const stat = await this.executor.exec(`wc -c < ${escaped}`, this.execOptions(context));
        if (stat.code === 0) size = Number.parseInt(stat.stdout.trim(), 10) || 0;
      }
      let mtimeMs = 0;
      const mtime = await this.executor.exec(`date -r ${escaped} +%s`, this.execOptions(context));
      if (mtime.code === 0) mtimeMs = (Number.parseInt(mtime.stdout.trim(), 10) || 0) * 1000;
      return { name: posix.basename(path), path, kind, size, mtimeMs };
    });
  }

  async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    return this.fileOp(async () => {
      const { stdout } = await this.run(`ls -A ${shellEscape(path)}`, context);
      const names = stdout.split("\n").filter(Boolean).toSorted();
      const entries: FileInfo[] = [];
      for (const name of names) {
        const child = posix.join(path, name);
        const info = await this.fileInfo(child, context);
        if (info.ok) entries.push(info.value);
      }
      return entries;
    });
  }

  canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.fileOp(async () =>
      (await this.run(`realpath ${shellEscape(path)}`, context)).stdout.trim(),
    );
  }

  async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    try {
      const result = await this.executor.exec(
        `test -e ${shellEscape(path)}`,
        this.execOptions(context),
      );
      return ok(result.code === 0);
    } catch (error) {
      return err(toFileError(error));
    }
  }

  createDir(
    path: string,
    options: { recursive?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    return this.fileOp(async () => {
      const flag = options?.recursive === false ? "" : "-p ";
      await this.run(`mkdir ${flag}${shellEscape(path)}`, context);
    });
  }

  remove(
    path: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    return this.fileOp(async () => {
      const recursive = options?.recursive ? "-r" : "";
      const force = options?.force ? "-f" : "";
      await this.run(`rm ${recursive} ${force} ${shellEscape(path)}`, context);
    });
  }

  createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
    return this.fileOp(async () => {
      const template = prefix === undefined ? "" : shellEscape(`${prefix}XXXXXX`);
      const { stdout } = await this.run(`mktemp -d ${template}`.trim(), context);
      return stdout.trim();
    });
  }

  createTempFile(
    options: { prefix?: string; suffix?: string } | undefined,
    context: Context,
  ): Promise<Result<string, FileError>> {
    return this.fileOp(async () => {
      const template =
        options?.prefix === undefined && options?.suffix === undefined
          ? ""
          : shellEscape(`${options?.prefix ?? ""}XXXXXX${options?.suffix ?? ""}`);
      const { stdout } = await this.run(`mktemp ${template}`.trim(), context);
      return stdout.trim();
    });
  }

  async cleanup(_context: Context): Promise<void> {}

  async exec(
    command: string,
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    try {
      const result = await this.executor.exec(command, {
        ...(options?.cwd ? { cwd: options.cwd } : {}),
        ...(options?.timeout ? { timeout: options.timeout } : {}),
        signal: context.abortSignal,
      });
      const combined = [result.stdout, result.stderr].filter((part) => part.length > 0).join("\n");
      const limits = options?.capture?.limits ?? {
        maxBytes: DEFAULT_MAX_BYTES,
        maxLines: DEFAULT_MAX_LINES,
        retain: "tail" as const,
      };
      const truncation =
        limits.retain === "head"
          ? truncateHead(combined, { maxLines: limits.maxLines, maxBytes: limits.maxBytes })
          : truncateTail(combined, { maxLines: limits.maxLines, maxBytes: limits.maxBytes });

      let spillPath: string | undefined;
      if (options?.capture?.spill && truncation.truncated) {
        try {
          spillPath = posix.join(this.cwd, SPILL_DIR, `${randomBytes(8).toString("hex")}.log`);
          await this.executor.writeFile(spillPath, combined, this.execOptions(context));
        } catch {
          spillPath = undefined;
        }
      }

      const metadata = shellOutputMetadata(truncation, spillPath);
      options?.onUpdate?.(
        { kind: "replace", output: { text: truncation.content, ...metadata } },
        context,
      );
      return ok({ exitCode: result.code, ...metadata });
    } catch (error) {
      return err(toExecutionError(error, context));
    }
  }

  private execOptions(context: Context): { signal: AbortSignal | undefined } {
    return { signal: context.abortSignal };
  }

  private async run(
    command: string,
    context: Context,
  ): Promise<{ stdout: string; stderr: string }> {
    const result = await this.executor.exec(command, this.execOptions(context));
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `Command failed (${result.code}): ${command}`);
    }
    return result;
  }

  private async fileOp<T>(op: () => Promise<T>): Promise<Result<T, FileError>> {
    try {
      return ok(await op());
    } catch (error) {
      return err(toFileError(error));
    }
  }
}

class ShellTextLineReader implements TextLineReader {
  private offset = 0;

  constructor(private readonly content: string) {}

  async readLine(_context: Context): Promise<Result<TextLine | undefined, FileError>> {
    if (this.offset >= this.content.length) return ok(undefined);
    const newline = this.content.indexOf("\n", this.offset);
    if (newline === -1) {
      const text = this.content.slice(this.offset);
      this.offset = this.content.length;
      return ok({ text, terminated: false });
    }
    const text = this.content.slice(this.offset, newline);
    this.offset = newline + 1;
    return ok({ text, terminated: true });
  }

  async close(_context: Context): Promise<void> {
    this.offset = this.content.length;
  }
}

function shellOutputMetadata(
  truncation: TruncationResult,
  spillPath: string | undefined,
): ShellOutputMetadata {
  const { content: _content, ...metadata } = truncation;
  const lastLine = truncation.content.split("\n").at(-1) ?? "";
  return {
    truncation: metadata,
    ...(spillPath ? { spillPath } : {}),
    ...(truncation.lastLinePartial ? { lastLineBytes: Buffer.byteLength(lastLine, "utf8") } : {}),
  };
}

function toFileError(error: unknown): FileError {
  const message = error instanceof Error ? error.message : String(error);
  if (/aborted/i.test(message)) return new FileError("aborted", message);
  if (/no such file|not found/i.test(message)) return new FileError("not_found", message);
  if (/permission denied/i.test(message)) return new FileError("permission_denied", message);
  if (/not a directory/i.test(message)) return new FileError("not_directory", message);
  if (/is a directory/i.test(message)) return new FileError("is_directory", message);
  return new FileError("unknown", message, undefined, error instanceof Error ? error : undefined);
}

function toExecutionError(error: unknown, context: Context): ExecutionError {
  const message = error instanceof Error ? error.message : String(error);
  if (context.abortSignal?.aborted || /aborted/i.test(message)) {
    return new ExecutionError("aborted", message);
  }
  if (/timed out/i.test(message)) return new ExecutionError("timeout", message);
  return new ExecutionError("unknown", message, error instanceof Error ? error : undefined);
}
