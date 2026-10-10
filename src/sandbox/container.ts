import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { constants as osConstants } from "node:os";
import { posix } from "node:path";
import type { Context } from "@earendil-works/chord";
import {
  ExecutionError,
  FileError,
  LineScanner,
  StreamDecoder,
  err,
  ok,
  type BinaryReader,
  type DirReader,
  type ExecutionEnv,
  type FileErrorCode,
  type FileInfo,
  type FileKind,
  type FileWatcher,
  type LineScan,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  type TextLine,
  type TextLineReader,
  type WatchChange,
  type WatchTarget,
} from "@earendil-works/pi-durable/env";
import type {
  ContainerExecutionEnvOptions,
  ContainerSandboxConfig,
  DockerExecFile,
  SandboxAdapter,
} from "./types.js";
import { SandboxError, execSimple, linkAbortSignal } from "./utils.js";
import { containerEngine } from "./engine.js";
import { errorMessage } from "../unknown-values.js";
import * as log from "../log.js";

const SPILL_DIR = ".mikan/bash-output";

function parseContainerSandboxArg(value: string): ContainerSandboxConfig | undefined {
  if (!value.startsWith("container:")) {
    return undefined;
  }

  const container = value.slice("container:".length);
  if (!container) {
    throw new SandboxError(
      "Error: container sandbox requires container name (e.g., container:mikan-sandbox)",
    );
  }
  return { type: "container", container };
}

async function validateContainerSandbox(config: ContainerSandboxConfig): Promise<void> {
  const engine = containerEngine();
  try {
    await execSimple(engine, ["--version"]);
  } catch {
    throw new SandboxError(
      `Error: no container engine found; install nerdctl, Podman, or Docker (tried '${engine}')`,
    );
  }

  try {
    const result = await execSimple(engine, [
      "inspect",
      "-f",
      "{{.State.Running}}",
      config.container,
    ]);
    if (result.trim() !== "true") {
      throw new SandboxError(`Error: Container '${config.container}' is not running.`, [
        `Start it with: ${engine} start ${config.container}`,
      ]);
    }
  } catch (error) {
    if (error instanceof SandboxError) {
      throw error;
    }
    throw new SandboxError(`Error: Container '${config.container}' does not exist.`, [
      `Create it with: ${engine} run -d --name ${config.container} -v <workspace>:/workspace docker.io/library/alpine:latest sleep infinity`,
    ]);
  }

  console.log(`  Container '${config.container}' is running (engine: ${engine}).`);
}

const GROUP_FILE_PREFIX = "/tmp/mikan-exec-";

const READ_ENV_FROM_STDIN =
  'while IFS= read -r line && [ -n "$line" ]; do export "${line%%=*}=$(printf %s "${line#*=}" | base64 -d)"; done;';

const RUN_IN_PROCESS_GROUP = [
  "group_file=$1; check=$2; marker=$3; shift 3;",
  READ_ENV_FROM_STDIN,
  `report() { printf '\\n%s%s\\n' "$marker" "$1" >&2; exit 0; };`,
  'if [ "$check" = 1 ] && ! command -v "$1" >/dev/null 2>&1; then report 127; fi;',
  "if command -v setsid >/dev/null 2>&1; then",
  `setsid sh -c 'echo "$$ $(cut -d" " -f22 /proc/$$/stat)" > "$0"; exec "$@"' "$group_file" "$@" </dev/null & wait $!;`,
  'status=$?; rm -f "$group_file"; report $status;',
  'fi; "$@" </dev/null; report $?',
].join(" ");

const STOP_RECORDED_GROUP = [
  'stop_group() { read group start < "$1" 2>/dev/null || return 0; rm -f "$1";',
  '[ "$group" -gt 1 ] 2>/dev/null || return 0;',
  '[ "$(cut -d" " -f22 /proc/$group/stat 2>/dev/null)" = "$start" ] || return 0;',
  'kill -s KILL -- -"$group" 2>/dev/null || kill -s KILL -"$group" 2>/dev/null; return 0; };',
].join(" ");

const KILL_PROCESS_GROUP = [
  STOP_RECORDED_GROUP,
  'i=0; while [ ! -s "$1" ] && [ $i -lt 10 ]; do sleep 0.1; i=$((i+1)); done;',
  'stop_group "$1"; exit 0',
].join(" ");

const SWEEP_PROCESS_GROUPS = [
  STOP_RECORDED_GROUP,
  `for file in ${GROUP_FILE_PREFIX}*; do [ -f "$file" ] && stop_group "$file"; done; exit 0`,
].join(" ");

export async function sweepOrphanedCommands(
  containerName: string,
  execFile: DockerExecFile,
  engine = containerEngine(),
): Promise<void> {
  try {
    await execFile(engine, ["exec", containerName, "sh", "-c", SWEEP_PROCESS_GROUPS]);
  } catch (error) {
    log.logWarning(`Could not end leftover commands in ${containerName}`, errorMessage(error));
  }
}

const FILE_STATUS_CODES: Record<number, FileErrorCode> = {
  70: "not_found",
  71: "is_directory",
  72: "not_directory",
  73: "invalid",
  74: "permission_denied",
};

const FILE_PRELUDE = [
  'fail() { echo "$2" >&2; exit "$1"; };',
  'need_entry() { [ -e "$1" ] || [ -L "$1" ] || fail 70 "No such file or directory: $1"; };',
  'need_file() { need_entry "$1"; if [ -d "$1" ]; then fail 71 "Is a directory: $1"; fi;',
  '[ -f "$1" ] || fail 73 "Not a regular file: $1"; [ -r "$1" ] || fail 74 "Permission denied: $1"; };',
  'need_dir() { need_entry "$1"; [ -d "$1" ] || fail 72 "Not a directory: $1"; };',
].join(" ");

const FILE_SCRIPTS = {
  read: 'need_file "$1"; exec cat "$1"',
  modifiedTimeThenContent:
    'if [ "$2" = 1 ] && [ -L "$1" ]; then fail 73 "Symbolic link: $1"; fi; need_file "$1"; stat -L -c %Y "$1" && cat "$1"',
  info: 'need_entry "$1"; stat -c "%F|%s|%Y" "$1"',
  directory: 'need_dir "$1"',
  list: [
    'need_dir "$1"; cd "$1" || fail 74 "Permission denied: $1";',
    'for f in * .[!.]* ..?*; do if [ -e "$f" ] || [ -L "$f" ]; then stat -c "%F|%s|%Y|%n" "$f"; fi; done',
  ].join(" "),
  write: [
    'if [ -d "$1" ]; then fail 71 "Is a directory: $1"; fi; mkdir -p "$(dirname "$1")" || exit $?;',
    'stage="$1.mikan-stage-$$"; if cat > "$stage" && mv -f "$stage" "$1"; then exit 0; fi;',
    'status=$?; rm -f "$stage"; exit $status',
  ].join(" "),
  append:
    'if [ -d "$1" ]; then fail 71 "Is a directory: $1"; fi; mkdir -p "$(dirname "$1")" && cat >> "$1"',
  truncate: 'need_file "$1"; truncate -s "$2" "$1"',
  flush: 'need_entry "$1"; sync "$1" 2>/dev/null || sync',
  rename: 'need_entry "$1"; mv -f "$1" "$2"',
  canonical: 'need_entry "$1"; realpath "$1"',
  exists: 'if [ -e "$1" ] || [ -L "$1" ]; then echo 1; else echo 0; fi',
  mkdir: 'if [ "$2" = 1 ]; then mkdir -p "$1"; else mkdir "$1"; fi',
  remove: [
    'if [ ! -e "$1" ] && [ ! -L "$1" ]; then [ "$3" = 1 ] && exit 0; fail 70 "No such file or directory: $1"; fi;',
    'if [ -d "$1" ] && [ ! -L "$1" ]; then [ "$2" = 1 ] || fail 71 "Is a directory: $1"; rm -rf "$1"; else rm -f "$1"; fi',
  ].join(" "),
  tempDir: 'mktemp -d "${TMPDIR:-/tmp}/$1XXXXXX"',
  tempFile:
    'dir=$(mktemp -d "${TMPDIR:-/tmp}/tmp-XXXXXX") && file="$dir/$1$(date +%s)$$$2" && : > "$file" && echo "$file"',
  spill: 'mkdir -p "$(dirname "$1")" && cat > "$1"',
} as const;

const GITHUB_CREDENTIAL_KEY = "credential.https://github.com.helper";

function withGitHubCredentialHelper(
  env?: Record<string, string>,
): Record<string, string> | undefined {
  if (!env || !hasGitHubToken(env) || env.GIT_CONFIG_COUNT !== undefined) {
    return env;
  }
  return {
    ...env,
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: GITHUB_CREDENTIAL_KEY,
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: GITHUB_CREDENTIAL_KEY,
    GIT_CONFIG_VALUE_1: "!gh auth git-credential",
  };
}

function hasGitHubToken(env: Record<string, string>): boolean {
  return Boolean(env.GH_TOKEN || env.GITHUB_TOKEN);
}

interface DockerOutcome {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
}

type DockerStream = "stdout" | "stderr";

function runDocker(
  docker: string,
  args: string[],
  options: {
    stdin?: Uint8Array | "open";
    onData?: (stream: DockerStream, chunk: Buffer) => void;
  } = {},
): { child: ChildProcess; done: Promise<DockerOutcome> } {
  const child = spawn(docker, args, {
    stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  const captured: Record<DockerStream, Buffer[]> = { stdout: [], stderr: [] };
  const done = new Promise<DockerOutcome>((resolve, reject) => {
    child.on("error", (error) =>
      reject(new Error(`${docker} ${args[0]}: ${error.message}`, { cause: error })),
    );
    for (const stream of ["stdout", "stderr"] as const) {
      child[stream]?.on("data", (chunk: Buffer) =>
        options.onData ? options.onData(stream, chunk) : captured[stream].push(chunk),
      );
    }
    child.on("exit", (_code, signal) => {
      if (!signal) return;
      child.stdout?.destroy();
      child.stderr?.destroy();
    });
    child.on("close", (code, signal) =>
      resolve({
        code: code ?? 128 + (signal ? (osConstants.signals[signal] ?? 0) : 0),
        stdout: Buffer.concat(captured.stdout),
        stderr: Buffer.concat(captured.stderr),
      }),
    );
  });
  child.stdin?.on("error", () => {});
  if (options.stdin instanceof Uint8Array) child.stdin?.end(options.stdin);
  return { child, done };
}

function abortedFile(path?: string): FileError {
  return new FileError("aborted", "aborted", path);
}

function invalid(message: string): FileError {
  return new FileError("invalid", message);
}

function fileErrorFromStderr(stderr: string, path: string): FileError {
  const message = stderr.trim();
  if (/no such file|not found/i.test(message)) return new FileError("not_found", message, path);
  if (/permission denied/i.test(message)) return new FileError("permission_denied", message, path);
  if (/not a directory/i.test(message)) return new FileError("not_directory", message, path);
  if (/is a directory/i.test(message)) return new FileError("is_directory", message, path);
  return new FileError("unknown", message || `Failed on ${path}`, path);
}

function fileKind(type: string): FileKind | undefined {
  if (type.startsWith("regular")) return "file";
  if (type === "directory") return "directory";
  if (type === "symbolic link") return "symlink";
  return undefined;
}

function parseStatLine(line: string, path: string): FileInfo | undefined {
  const [type = "", size = "0", mtime = "0"] = line.split("|", 3);
  const kind = fileKind(type);
  if (!kind) return undefined;
  return {
    name: posix.basename(path),
    path,
    kind,
    size: Number.parseInt(size, 10) || 0,
    mtimeMs: (Number.parseInt(mtime, 10) || 0) * 1000,
  };
}

export class ContainerExecutionEnv implements ExecutionEnv {
  readonly id: string;
  readonly cwd: string;
  private readonly container: string;
  private readonly engine: string | undefined;
  private readonly env: Record<string, string> | undefined;
  private readonly ensureReady: () => Promise<void>;
  private readonly running = new Map<string, ChildProcess>();

  constructor(options: ContainerExecutionEnvOptions) {
    this.container = options.container;
    this.engine = options.docker;
    this.id = `docker:${options.container}`;
    this.cwd = options.cwd;
    this.env = withGitHubCredentialHelper(options.env);
    this.ensureReady =
      options.ensureReady ?? (() => ensureContainerRunning(options.container, this.docker));
  }

  async absolutePath(path: string, _context: Context): Promise<Result<string, FileError>> {
    return ok(this.resolve(path));
  }

  async joinPath(parts: string[], _context: Context): Promise<Result<string, FileError>> {
    return ok(posix.join(...parts));
  }

  async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    const result = await this.readBinaryFile(path, context);
    return result.ok ? ok(Buffer.from(result.value).toString("utf8")) : result;
  }

  async openTextLineReader(
    path: string,
    context: Context,
  ): Promise<Result<TextLineReader, FileError>> {
    const result = await this.readTextFile(path, context);
    return result.ok ? ok(new SnapshotTextLineReader(result.value)) : result;
  }

  async readTextLines(
    path: string,
    options: { maxLines?: number } | undefined,
    context: Context,
  ): Promise<Result<string[], FileError>> {
    const result = await this.readTextFile(path, context);
    if (!result.ok) return result;
    const lines = result.value.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const max = options?.maxLines;
    return ok(max === undefined ? lines : lines.slice(0, Math.max(0, Math.floor(max))));
  }

  readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    return this.fileScript(FILE_SCRIPTS.read, [this.resolve(path)], context);
  }

  async openBinaryReader(
    path: string,
    options: { noFollow?: boolean } | undefined,
    context: Context,
  ): Promise<Result<BinaryReader, FileError>> {
    const resolved = this.resolve(path);
    const result = await this.fileScript(
      FILE_SCRIPTS.modifiedTimeThenContent,
      [resolved, options?.noFollow ? "1" : "0"],
      context,
    );
    if (!result.ok) return result;
    const newline = result.value.indexOf(0x0a);
    const mtime = Number.parseInt(result.value.subarray(0, newline).toString(), 10) || 0;
    const bytes = result.value.subarray(newline + 1);
    return ok(
      new SnapshotBinaryReader(bytes, {
        name: posix.basename(resolved),
        path: resolved,
        kind: "file",
        size: bytes.length,
        mtimeMs: mtime * 1000,
      }),
    );
  }

  async writeFile(
    path: string,
    content: string | Uint8Array,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const result = await this.fileScript(
      FILE_SCRIPTS.write,
      [this.resolve(path)],
      context,
      Buffer.from(content),
    );
    return result.ok ? ok(undefined) : result;
  }

  async appendFile(
    path: string,
    content: string | Uint8Array,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const result = await this.fileScript(
      FILE_SCRIPTS.append,
      [this.resolve(path)],
      context,
      Buffer.from(content),
    );
    return result.ok ? ok(undefined) : result;
  }

  async truncateFile(
    path: string,
    size: number,
    context: Context,
  ): Promise<Result<void, FileError>> {
    if (!Number.isInteger(size) || size < 0) return err(invalid(`Invalid size: ${size}`));
    const result = await this.fileScript(
      FILE_SCRIPTS.truncate,
      [this.resolve(path), String(size)],
      context,
    );
    return result.ok ? ok(undefined) : result;
  }

  async flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
    const result = await this.fileScript(FILE_SCRIPTS.flush, [this.resolve(path)], context);
    return result.ok ? ok(undefined) : result;
  }

  async renameFile(
    sourcePath: string,
    destinationPath: string,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const result = await this.fileScript(
      FILE_SCRIPTS.rename,
      [this.resolve(sourcePath), this.resolve(destinationPath)],
      context,
    );
    return result.ok ? ok(undefined) : result;
  }

  async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    const resolved = this.resolve(path);
    const result = await this.fileScript(FILE_SCRIPTS.info, [resolved], context);
    if (!result.ok) return result;
    const info = parseStatLine(result.value.toString().trim(), resolved);
    return info ? ok(info) : err(new FileError("invalid", `Unsupported file kind: ${resolved}`));
  }

  async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    const resolved = this.resolve(path);
    const result = await this.fileScript(FILE_SCRIPTS.list, [resolved], context);
    if (!result.ok) return result;
    const entries: FileInfo[] = [];
    for (const line of result.value.toString().split("\n")) {
      const name = line.split("|").slice(3).join("|");
      if (!name) continue;
      const info = parseStatLine(line, posix.join(resolved, name));
      if (info) entries.push(info);
    }
    return ok(entries.toSorted((a, b) => a.name.localeCompare(b.name)));
  }

  async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
    const resolved = this.resolve(path);
    const directory = await this.fileScript(FILE_SCRIPTS.directory, [resolved], context);
    if (!directory.ok) return directory;
    return ok(new ContainerDirReader((readContext) => this.listDir(resolved, readContext)));
  }

  async watch(
    _targets: readonly WatchTarget[],
    _onChange: (change: WatchChange) => void,
    _context: Context,
  ): Promise<Result<FileWatcher, FileError>> {
    return err(new FileError("not_supported", "The sandbox does not report file changes"));
  }

  async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    const result = await this.fileScript(FILE_SCRIPTS.canonical, [this.resolve(path)], context);
    return result.ok ? ok(result.value.toString().trim()) : result;
  }

  async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    const result = await this.fileScript(FILE_SCRIPTS.exists, [this.resolve(path)], context);
    return result.ok ? ok(result.value.toString().trim() === "1") : result;
  }

  async createDir(
    path: string,
    options: { recursive?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const result = await this.fileScript(
      FILE_SCRIPTS.mkdir,
      [this.resolve(path), options?.recursive === false ? "0" : "1"],
      context,
    );
    return result.ok ? ok(undefined) : result;
  }

  async remove(
    path: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const result = await this.fileScript(
      FILE_SCRIPTS.remove,
      [this.resolve(path), options?.recursive ? "1" : "0", options?.force ? "1" : "0"],
      context,
    );
    return result.ok ? ok(undefined) : result;
  }

  async createTempDir(
    prefix: string | undefined,
    context: Context,
  ): Promise<Result<string, FileError>> {
    const result = await this.fileScript(FILE_SCRIPTS.tempDir, [prefix ?? "tmp-"], context);
    return result.ok ? ok(result.value.toString().trim()) : result;
  }

  async createTempFile(
    options: { prefix?: string; suffix?: string } | undefined,
    context: Context,
  ): Promise<Result<string, FileError>> {
    const result = await this.fileScript(
      FILE_SCRIPTS.tempFile,
      [options?.prefix ?? "", options?.suffix ?? ""],
      context,
    );
    return result.ok ? ok(result.value.toString().trim()) : result;
  }

  async cleanup(_context: Context): Promise<void> {
    const running = [...this.running];
    this.running.clear();
    await Promise.all(
      running.map(([groupFile, child]) => {
        child.kill("SIGKILL");
        return this.killProcessGroup(groupFile);
      }),
    );
  }

  async exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    const signal = context.abortSignal;
    if (signal?.aborted) return err(new ExecutionError("aborted", "aborted"));
    const argv = typeof command === "string" ? ["sh", "-c", command] : [...command];
    if (argv.length === 0) {
      return err(new ExecutionError("spawn_error", "Empty argv: no program to run"));
    }
    const timeout = options?.timeout;
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
      return err(
        new ExecutionError("timeout", "Invalid timeout: must be a finite number of seconds"),
      );
    }
    try {
      await this.ensureReady();
    } catch (error) {
      return err(new ExecutionError("unknown", errorMessage(error), toError(error)));
    }

    const groupFile = `${GROUP_FILE_PREFIX}${randomUUID()}`;
    const marker = exitMarker();
    const cwd = options?.cwd ? this.resolve(options.cwd) : this.cwd;
    const output = new ExecOutput(options, context, marker, () => {
      const path = posix.join(this.cwd, SPILL_DIR, `${randomBytes(8).toString("hex")}.log`);
      const args = [
        "exec",
        "-i",
        this.container,
        "sh",
        "-c",
        `${FILE_PRELUDE} ${FILE_SCRIPTS.spill}`,
      ];
      return { path, ...runDocker(this.docker, [...args, "sh", path], { stdin: "open" }) };
    });
    const { child, done } = runDocker(
      this.docker,
      [
        "exec",
        "-i",
        "-w",
        cwd,
        this.container,
        "sh",
        "-c",
        RUN_IN_PROCESS_GROUP,
        "sh",
        groupFile,
        typeof command === "string" ? "0" : "1",
        marker,
        ...argv,
      ],
      {
        stdin: encodeEnvForStdin({ ...this.env, ...options?.env }),
        onData: (stream, chunk) => output.push(stream, chunk),
      },
    );
    this.running.set(groupFile, child);

    let interruption: "timeout" | "aborted" | undefined;
    let stopping: Promise<void> | undefined;
    const stop = (reason: "timeout" | "aborted") => {
      interruption ??= reason;
      child.kill("SIGKILL");
      stopping ??= this.killProcessGroup(groupFile);
    };
    output.onCallbackError = () => stop("aborted");
    const timer =
      timeout === undefined ? undefined : setTimeout(() => stop("timeout"), timeout * 1000);
    const unlinkSignal = linkAbortSignal(signal, () => stop("aborted"));

    try {
      const { code } = await done;
      await stopping;
      const spillPath = await output.finish();
      if (output.callbackError) return err(output.callbackError);
      if (interruption) {
        const error =
          interruption === "timeout"
            ? new ExecutionError("timeout", `Command timed out after ${timeout} seconds`)
            : new ExecutionError("aborted", "aborted");
        if (spillPath !== undefined) error.spillPath = spillPath;
        return err(error);
      }
      const exitCode = output.exitStatus ?? code;
      if (typeof command !== "string" && exitCode === 127 && output.bytes === 0) {
        return err(new ExecutionError("spawn_error", `Program not found: ${argv[0]}`));
      }
      return ok(spillPath === undefined ? { exitCode } : { exitCode, spillPath });
    } catch (error) {
      return err(new ExecutionError("spawn_error", errorMessage(error), toError(error)));
    } finally {
      if (timer) clearTimeout(timer);
      unlinkSignal();
      this.running.delete(groupFile);
    }
  }

  private get docker(): string {
    return this.engine ?? containerEngine();
  }

  private resolve(path: string): string {
    return posix.isAbsolute(path) ? posix.normalize(path) : posix.resolve(this.cwd, path);
  }

  private async fileScript(
    script: string,
    args: string[],
    context: Context,
    stdin?: Uint8Array,
  ): Promise<Result<Buffer, FileError>> {
    const path = args[0] ?? "";
    if (context.abortSignal?.aborted) return err(abortedFile(path));
    try {
      await this.ensureReady();
      const marker = exitMarker();
      const { child, done } = runDocker(
        this.docker,
        [
          "exec",
          ...(stdin === undefined ? [] : ["-i"]),
          this.container,
          "sh",
          "-c",
          `${FILE_PRELUDE} ( ${script} ); printf '\\n%s%s\\n' '${marker}' "$?" >&2`,
          "sh",
          ...args,
        ],
        { stdin },
      );
      const unlinkSignal = linkAbortSignal(context.abortSignal, () => child.kill("SIGKILL"));
      const outcome = await done.finally(unlinkSignal);
      if (context.abortSignal?.aborted) return err(abortedFile(path));
      const reported = takeExitStatus(outcome.stderr, marker);
      const status = reported.status ?? outcome.code;
      if (status === 0) return ok(outcome.stdout);
      const stderr = reported.rest.toString();
      const code = FILE_STATUS_CODES[status];
      return err(
        code ? new FileError(code, stderr.trim(), path) : fileErrorFromStderr(stderr, path),
      );
    } catch (error) {
      return err(new FileError("unknown", errorMessage(error), path, toError(error)));
    }
  }

  private async killProcessGroup(groupFile: string): Promise<void> {
    const { done } = runDocker(this.docker, [
      "exec",
      this.container,
      "sh",
      "-c",
      KILL_PROCESS_GROUP,
      "sh",
      groupFile,
    ]);
    try {
      await done;
    } catch (error) {
      log.logWarning(
        `Could not stop a command in container ${this.container}`,
        errorMessage(error),
      );
    }
  }
}

class ExecOutput {
  bytes = 0;
  exitStatus: number | undefined;
  callbackError: ExecutionError | undefined;
  onCallbackError: (() => void) | undefined;
  private newlines = 0;
  private readonly decoders = { stdout: new StreamDecoder(), stderr: new StreamDecoder() };
  private readonly prefix: Buffer[] = [];
  private spill: { path: string; child: ChildProcess; done: Promise<DockerOutcome> } | undefined;
  private finished = false;
  private stderrTail = Buffer.alloc(0);

  constructor(
    private readonly options: ShellExecOptions | undefined,
    private readonly context: Context,
    private readonly marker: string,
    private readonly openSpill: () => {
      path: string;
      child: ChildProcess;
      done: Promise<DockerOutcome>;
    },
  ) {}

  push(stream: DockerStream, chunk: Buffer): void {
    if (stream === "stdout") {
      this.deliver(stream, chunk);
      return;
    }
    const tail = Buffer.concat([this.stderrTail, chunk]);
    const held = Math.min(tail.length, this.marker.length + EXIT_STATUS_MAX_CHARS);
    this.stderrTail = tail.subarray(tail.length - held);
    if (tail.length > held) this.deliver(stream, tail.subarray(0, tail.length - held));
  }

  async finish(): Promise<string | undefined> {
    const reported = takeExitStatus(this.stderrTail, this.marker);
    this.exitStatus = reported.status;
    if (reported.rest.length > 0) this.deliver("stderr", reported.rest);
    this.emit(this.decoders.stdout.decode(), "stdout");
    this.emit(this.decoders.stderr.decode(), "stderr");
    this.finished = true;
    if (!this.spill) return undefined;
    this.spill.child.stdin?.end();
    const outcome = await this.spill.done.catch(() => undefined);
    return outcome?.code === 0 ? this.spill.path : undefined;
  }

  private deliver(stream: DockerStream, chunk: Buffer): void {
    this.bytes += chunk.length;
    this.emit(this.decoders[stream].decode(chunk), stream);
    this.recordForSpill(chunk);
  }

  private emit(text: string, stream: DockerStream): void {
    const onOutput = this.options?.onOutput;
    if (this.finished || text === "" || !onOutput || this.callbackError) return;
    try {
      onOutput(text, this.context, { stream });
    } catch (error) {
      this.callbackError = new ExecutionError(
        "callback_error",
        errorMessage(error),
        toError(error),
      );
      this.onCallbackError?.();
    }
  }

  private recordForSpill(chunk: Buffer): void {
    const limits = this.options?.spill;
    if (!limits || chunk.length === 0) return;
    if (this.spill) {
      this.spill.child.stdin?.write(chunk);
      return;
    }
    for (let i = chunk.indexOf(0x0a); i !== -1; i = chunk.indexOf(0x0a, i + 1)) this.newlines++;
    const lines = this.newlines + (chunk[chunk.length - 1] === 0x0a ? 0 : 1);
    this.prefix.push(chunk);
    if (this.bytes <= limits.afterBytes && lines <= limits.afterLines) return;
    this.spill = this.openSpill();
    for (const queued of this.prefix) this.spill.child.stdin?.write(queued);
    this.prefix.length = 0;
  }
}

class SnapshotBinaryReader implements BinaryReader {
  private closed = false;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly metadata: FileInfo,
  ) {}

  async info(_context: Context): Promise<Result<FileInfo, FileError>> {
    return this.closed ? err(invalid("Reader is closed")) : ok(this.metadata);
  }

  async read(
    offset: number,
    length: number,
    context: Context,
  ): Promise<Result<Uint8Array, FileError>> {
    if (this.closed) return err(invalid("Reader is closed"));
    if (context.abortSignal?.aborted) return err(abortedFile(this.metadata.path));
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 0) {
      return err(invalid(`Invalid range: offset ${offset}, length ${length}`));
    }
    return ok(this.bytes.subarray(offset, offset + length));
  }

  async scanLines(
    options: { startLine: number; endLine?: number },
    context: Context,
  ): Promise<Result<LineScan, FileError>> {
    if (this.closed) return err(invalid("Reader is closed"));
    if (context.abortSignal?.aborted) return err(abortedFile(this.metadata.path));
    try {
      const scanner = new LineScanner(options.startLine, options.endLine);
      scanner.push(this.bytes);
      return ok(scanner.finish());
    } catch (error) {
      return err(invalid(errorMessage(error)));
    }
  }

  async close(_context: Context): Promise<void> {
    this.closed = true;
  }
}

class ContainerDirReader implements DirReader {
  private entries: FileInfo[] | undefined;
  private offset = 0;
  private closed = false;

  constructor(
    private readonly list: (context: Context) => Promise<Result<FileInfo[], FileError>>,
  ) {}

  async next(
    maxEntries: number,
    context: Context,
  ): Promise<Result<{ entries: FileInfo[]; done: boolean }, FileError>> {
    if (this.closed) return err(invalid("Reader is closed"));
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      return err(invalid(`Invalid page size: ${maxEntries}`));
    }
    if (context.abortSignal?.aborted) return err(abortedFile());
    if (!this.entries) {
      const listed = await this.list(context);
      if (!listed.ok) return listed;
      this.entries = listed.value;
    }
    const page = this.entries.slice(this.offset, this.offset + maxEntries);
    this.offset += page.length;
    return ok({ entries: page, done: this.offset >= this.entries.length });
  }

  async close(_context: Context): Promise<void> {
    this.closed = true;
  }
}

class SnapshotTextLineReader implements TextLineReader {
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

function toError(error: unknown): Error | undefined {
  return error instanceof Error ? error : undefined;
}

export const containerSandboxAdapter: SandboxAdapter<ContainerSandboxConfig> = {
  type: "container",
  credentials: { env: true, fileMounts: false },
  workspace: { managedProjection: false },
  parse: parseContainerSandboxArg,
  validate: validateContainerSandbox,
  createEnv: (config, options) =>
    new ContainerExecutionEnv({ ...options, container: config.container }),
};

async function ensureContainerRunning(container: string, engine: string): Promise<void> {
  try {
    const running = await execSimple(engine, ["inspect", "-f", "{{.State.Running}}", container]);
    if (running.trim() === "true") {
      return;
    }
    await execSimple(engine, ["start", container]);
  } catch (error) {
    const details = errorMessage(error);
    throw new Error(
      `Container "${container}" is not available. ` +
        `Expected a pre-existing container or image provisioning to keep it running.\n${details}`.trim(),
      { cause: error },
    );
  }
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function encodeEnvForStdin(env: Record<string, string>): Buffer {
  const lines = Object.entries(env)
    .filter(([name]) => ENV_NAME.test(name))
    .map(([name, value]) => `${name}=${Buffer.from(value).toString("base64")}\n`);
  return Buffer.from(`${lines.join("")}\n`);
}

const EXIT_STATUS_MAX_CHARS = 8;

function exitMarker(): string {
  return `mikan-exit-${randomBytes(8).toString("hex")}:`;
}

function takeExitStatus(stderr: Buffer, marker: string): { status?: number; rest: Buffer } {
  const text = stderr.toString("latin1");
  const at = text.lastIndexOf(`\n${marker}`);
  if (at === -1) return { rest: stderr };
  const status = Number.parseInt(text.slice(at + 1 + marker.length), 10);
  if (Number.isNaN(status)) return { rest: stderr };
  return { status, rest: stderr.subarray(0, at) };
}
