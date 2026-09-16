import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  closeSync,
  constants as fsConstants,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { resolve } from "node:path";
import * as log from "./log.js";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";

export function ensureDirExists(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function readTextFileIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, "utf-8");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

export function readJsonFileIfExists<T>(
  path: string,
  validate: (value: unknown) => value is T,
  malformedMessage: (detail: string) => string,
): T | undefined {
  const raw = readTextFileIfExists(path);
  return raw === undefined ? undefined : parseJsonValue(raw, validate, malformedMessage);
}

export function readJsonSchemaFileIfExists<T extends TSchema>(
  path: string,
  schema: T,
  malformedMessage: (detail: string) => string,
): Static<T> | undefined {
  const raw = readTextFileIfExists(path);
  return raw === undefined ? undefined : parseJsonSchemaValue(raw, schema, malformedMessage);
}

function parseJson(raw: string, malformedMessage: (detail: string) => string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(malformedMessage(detail), { cause: err });
  }
}

export function parseJsonValue<T>(
  raw: string,
  validate: (value: unknown) => value is T,
  malformedMessage: (detail: string) => string,
): T {
  const parsed = parseJson(raw, malformedMessage);
  if (!validate(parsed)) {
    throw new Error(malformedMessage("unexpected JSON shape"));
  }
  return parsed;
}

export function parseJsonSchemaValue<T extends TSchema>(
  raw: string,
  schema: T,
  malformedMessage: (detail: string) => string,
): Static<T> {
  const parsed = parseJson(raw, malformedMessage);
  if (!Value.Check(schema, parsed)) {
    let firstError: { path: string; message: string } | undefined;
    for (const err of Value.Errors(schema, parsed)) {
      firstError = err;
      break;
    }
    const detail =
      !firstError || firstError.path === "" || firstError.path === "/"
        ? "unexpected JSON shape"
        : `${firstError.path}: ${firstError.message}`;
    throw new Error(malformedMessage(detail));
  }
  return parsed;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PRIVATE_FILE_MODE = 0o600;

/**
 * Write `content` to `targetPath` with mode 0600, even when `targetPath`
 * already exists. Uses O_CREAT|O_EXCL on a temp sibling (so the kernel
 * guarantees permissions at creation, not after a racy chmod) and then
 * rename(2) into place for atomicity. Readers never see a torn write,
 * and a crash mid-write leaves either the old file or a stray .tmp
 * (cleaned by the next attempt or manually) — never a half-written target.
 */
export function atomicWritePrivateFile(targetPath: string, content: string): void {
  const dir = dirname(targetPath);
  const tmpPath = join(
    dir,
    `.${basename(targetPath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  const fd = openSync(
    tmpPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    PRIVATE_FILE_MODE,
  );
  try {
    writeSync(fd, content);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore — original error is more informative
    }
    throw err;
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    throw err;
  }
}

/**
 * True when `child` is `parent` or a path inside it. Purely lexical (no
 * symlink resolution) — used for configuration sanity checks, not as the
 * final security boundary.
 */
function isPathInside(child: string, parent: string): boolean {
  const parentPath = resolve(parent);
  const childPath = resolve(child);
  return childPath === parentPath || childPath.startsWith(parentPath + "/");
}

/**
 * The state dir (settings, office records, vaults) must never live inside
 * the working dir: conversation opt-in "full" mode mounts the entire working
 * dir read-write into sandbox containers, which would expose host-authoritative
 * state and credentials. Fatal under sandboxed modes; host mode has no mounts,
 * so only warn about the bad hygiene.
 */
export function assertStateDirOutsideWorkspace(
  stateDir: string,
  workingDir: string,
  sandboxType: string,
): void {
  if (!isPathInside(stateDir, workingDir)) return;
  const message =
    `--state-dir (${stateDir}) must not be inside the working directory (${workingDir}): ` +
    `sandbox containers mount the working directory, and a mounted state dir ` +
    `would expose settings, office records, vaults, and credentials to sandboxed code.`;
  if (sandboxType === "host") {
    log.logWarning("Insecure state dir location", message);
    return;
  }
  throw new Error(message);
}
