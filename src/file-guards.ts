import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { existsSync, mkdirSync, readFileSync } from "fs";

export function ensureDirExists(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function readTextFileIfExists(path: string): string | undefined {
  if (!existsSync(path)) {
    return undefined;
  }

  return readFileSync(path, "utf-8");
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
