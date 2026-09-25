import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
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
import { errorMessage } from "./unknown-values.js";

type JsonFailureKind = "syntax" | "shape" | "field";

type MalformedJsonMessage = (detail: string, kind: JsonFailureKind) => string;

const UNEXPECTED_JSON_SHAPE = "unexpected JSON shape";

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
  malformedMessage: MalformedJsonMessage,
): T | undefined {
  const raw = readTextFileIfExists(path);
  return raw === undefined ? undefined : parseJsonValue(raw, validate, malformedMessage);
}

export function readJsonSchemaFileIfExists<T extends TSchema>(
  path: string,
  schema: T,
  malformedMessage: MalformedJsonMessage,
): Static<T> | undefined {
  const raw = readTextFileIfExists(path);
  return raw === undefined ? undefined : parseJsonSchemaValue(raw, schema, malformedMessage);
}

function parseJson(raw: string, malformedMessage: MalformedJsonMessage): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    const detail = errorMessage(err);
    throw new Error(malformedMessage(detail, "syntax"), { cause: err });
  }
}

export function parseJsonValue<T>(
  raw: string,
  validate: (value: unknown) => value is T,
  malformedMessage: MalformedJsonMessage,
): T {
  const parsed = parseJson(raw, malformedMessage);
  if (!validate(parsed)) {
    throw new Error(malformedMessage(UNEXPECTED_JSON_SHAPE, "shape"));
  }
  return parsed;
}

export function parseJsonSchemaValue<T extends TSchema>(
  raw: string,
  schema: T,
  malformedMessage: MalformedJsonMessage,
): Static<T> {
  const parsed = parseJson(raw, malformedMessage);
  if (!Value.Check(schema, parsed)) {
    const firstError = Value.Errors(schema, parsed)[0];
    if (!firstError || firstError.instancePath === "" || firstError.instancePath === "/") {
      throw new Error(malformedMessage(UNEXPECTED_JSON_SHAPE, "shape"));
    }
    throw new Error(malformedMessage(`${firstError.instancePath}: ${firstError.message}`, "field"));
  }
  return parsed;
}

const PRIVATE_FILE_MODE = 0o600;

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
    } catch {}
    throw err;
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {}
    throw err;
  }
}

function isPathInside(child: string, parent: string): boolean {
  const parentPath = resolve(parent);
  const childPath = resolve(child);
  return childPath === parentPath || childPath.startsWith(parentPath + "/");
}

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
