import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import type { Context } from "@earendil-works/chord";
import {
  ExecutionError,
  FileError,
  LineScanner,
  err,
  ok,
  type BinaryReader,
  type DirReader,
  type ExecutionEnv,
  type FileInfo,
  type FileKind,
  type FileWatcher,
  type LineScan,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  type TextLine,
  type TextLineReader,
} from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { Executor, SandboxConfig } from "../sandbox/types.js";
import { execAppendFile, execWriteFile, shellEscape } from "../sandbox/utils.js";
import { errorMessage } from "../unknown-values.js";

const SPILL_DIR = ".mikan/bash-output";

const READ_REGULAR_FILE = [
  'if [ "$2" = 1 ] && [ -L "$1" ]; then echo link;',
  'elif [ -d "$1" ]; then echo directory;',
  'elif [ -f "$1" ]; then echo "file $(date -r "$1" +%s)"; base64 < "$1";',
  'elif [ -e "$1" ]; then echo other; else echo missing; fi',
].join(" ");

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

class ShellExecutionEnv implements ExecutionEnv {
  readonly id: string;
  readonly cwd: string;

  constructor(
    private readonly executor: Executor,
    runtimeWorkspaceRoot: string,
  ) {
    this.id = `mikan-sandbox:${randomBytes(8).toString("hex")}`;
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

  truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
    return this.fileOp(async () => {
      await this.run(`truncate -s ${Math.max(0, Math.floor(size))} ${shellEscape(path)}`, context);
    });
  }

  flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
    return this.fileOp(async () => {
      await this.run(`sync ${shellEscape(path)}`, context);
    });
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

  async openBinaryReader(
    path: string,
    options: { noFollow?: boolean } | undefined,
    context: Context,
  ): Promise<Result<BinaryReader, FileError>> {
    return this.fileOp(async () => {
      const { stdout } = await this.run(
        `sh -c ${shellEscape(READ_REGULAR_FILE)} _ ${shellEscape(path)} ${options?.noFollow ? 1 : 0}`,
        context,
      );
      const headerEnd = stdout.indexOf("\n");
      const [kind, mtime] = stdout.slice(0, headerEnd).split(" ");
      if (kind === "missing") throw new FileError("not_found", `No such file: ${path}`, path);
      if (kind === "directory")
        throw new FileError("is_directory", `Is a directory: ${path}`, path);
      if (kind !== "file") throw new FileError("invalid", `Not a regular file: ${path}`, path);
      const bytes = Buffer.from(stdout.slice(headerEnd + 1).replace(/\s+/g, ""), "base64");
      return new SnapshotBinaryReader(bytes, {
        name: posix.basename(path),
        path,
        kind: "file",
        size: bytes.length,
        mtimeMs: (Number.parseInt(mtime ?? "", 10) || 0) * 1000,
      });
    });
  }

  openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
    return this.fileOp(async () => {
      const listed = await this.listDir(path, context);
      if (!listed.ok) throw listed.error;
      return new SnapshotDirReader(listed.value);
    });
  }

  async watch(): Promise<Result<FileWatcher, FileError>> {
    return err(new FileError("not_supported", "The sandbox does not report file changes"));
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
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    try {
      const shellCommand =
        typeof command === "string" ? command : command.map(shellEscape).join(" ");
      const result = await this.executor.exec(shellCommand, {
        cwd: options?.cwd || undefined,
        timeout: options?.timeout || undefined,
        signal: context.abortSignal,
      });
      const stdout =
        result.stdout.length > 0 && result.stderr.length > 0 ? `${result.stdout}\n` : result.stdout;
      if (stdout.length > 0) options?.onOutput?.(stdout, context, { stream: "stdout" });
      if (result.stderr.length > 0) {
        options?.onOutput?.(result.stderr, context, { stream: "stderr" });
      }
      const combined = `${stdout}${result.stderr}`;
      return ok({ exitCode: result.code, spillPath: await this.spill(combined, options, context) });
    } catch (error) {
      return err(toExecutionError(error, context));
    }
  }

  private async spill(
    output: string,
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<string | undefined> {
    const limits = options?.spill;
    if (!limits) return undefined;
    const lines = output.split("\n").length;
    if (Buffer.byteLength(output, "utf8") <= limits.afterBytes && lines <= limits.afterLines)
      return undefined;
    try {
      const spillPath = posix.join(this.cwd, SPILL_DIR, `${randomBytes(8).toString("hex")}.log`);
      await this.executor.writeFile(spillPath, output, this.execOptions(context));
      return spillPath;
    } catch {
      return undefined;
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

class SnapshotBinaryReader implements BinaryReader {
  constructor(
    private readonly bytes: Uint8Array,
    private readonly metadata: FileInfo,
  ) {}

  async info(_context: Context): Promise<Result<FileInfo, FileError>> {
    return ok(this.metadata);
  }

  async read(
    offset: number,
    length: number,
    _context: Context,
  ): Promise<Result<Uint8Array, FileError>> {
    return ok(this.bytes.subarray(offset, offset + length));
  }

  async scanLines(
    options: { startLine: number; endLine?: number },
    _context: Context,
  ): Promise<Result<LineScan, FileError>> {
    const scanner = new LineScanner(options.startLine, options.endLine);
    scanner.push(this.bytes);
    return ok(scanner.finish());
  }

  async close(_context: Context): Promise<void> {}
}

class SnapshotDirReader implements DirReader {
  private offset = 0;

  constructor(private readonly entries: FileInfo[]) {}

  async next(
    maxEntries: number,
    _context: Context,
  ): Promise<Result<{ entries: FileInfo[]; done: boolean }, FileError>> {
    const page = this.entries.slice(this.offset, this.offset + Math.max(1, maxEntries));
    this.offset += page.length;
    return ok({ entries: page, done: this.offset >= this.entries.length });
  }

  async close(_context: Context): Promise<void> {
    this.offset = this.entries.length;
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

function toFileError(error: unknown): FileError {
  if (error instanceof FileError) return error;
  const message = errorMessage(error);
  if (/aborted/i.test(message)) return new FileError("aborted", message);
  if (/no such file|not found/i.test(message)) return new FileError("not_found", message);
  if (/permission denied/i.test(message)) return new FileError("permission_denied", message);
  if (/not a directory/i.test(message)) return new FileError("not_directory", message);
  if (/is a directory/i.test(message)) return new FileError("is_directory", message);
  return new FileError("unknown", message, undefined, error instanceof Error ? error : undefined);
}

function toExecutionError(error: unknown, context: Context): ExecutionError {
  const message = errorMessage(error);
  if (context.abortSignal?.aborted || /aborted/i.test(message)) {
    return new ExecutionError("aborted", message);
  }
  if (/timed out/i.test(message)) return new ExecutionError("timeout", message);
  return new ExecutionError("unknown", message, error instanceof Error ? error : undefined);
}
