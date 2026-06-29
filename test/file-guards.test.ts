import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Type } from "@sinclair/typebox";
import {
  ensureDirExists,
  isRecord,
  parseJsonSchemaValue,
  parseJsonValue,
  readJsonFileIfExists,
  readJsonSchemaFileIfExists,
  readTextFileIfExists,
} from "../src/utils/file-guards.js";

describe("ensureDirExists", () => {
  let dir: string;

  afterEach(() => {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true });
  });

  test("creates directory recursively", () => {
    dir = join(tmpdir(), `mikan-test-${Date.now()}`, "a", "b", "c");
    expect(() => ensureDirExists(dir)).not.toThrow();
    expect(existsSync(dir)).toBe(true);
  });

  test("does not throw if directory already exists", () => {
    dir = join(tmpdir(), `mikan-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    expect(() => ensureDirExists(dir)).not.toThrow();
  });
});

describe("readTextFileIfExists", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = join(tmpdir(), `mikan-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    filePath = join(dir, "test.txt");
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true });
  });

  test("reads existing file", () => {
    writeFileSync(filePath, "content", "utf-8");
    expect(readTextFileIfExists(filePath)).toBe("content");
  });

  test("returns undefined for missing file", () => {
    expect(readTextFileIfExists(join(dir, "nonexistent"))).toBeUndefined();
  });

  test("throws for non-ENOENT error", () => {
    expect(() => readTextFileIfExists("/tmp/")).toThrow();
  });
});

describe("readJsonFileIfExists", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = join(tmpdir(), `mikan-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    filePath = join(dir, "config.json");
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true });
  });

  test("reads and validates JSON", () => {
    writeFileSync(filePath, '{"key": "value"}', "utf-8");
    const result = readJsonFileIfExists(
      filePath,
      (v): v is Record<string, string> => isRecord(v),
      (d) => `Invalid config: ${d}`,
    );
    expect(result).toEqual({ key: "value" });
  });

  test("returns undefined for missing file", () => {
    expect(
      readJsonFileIfExists(
        join(dir, "nonexistent.json"),
        (v): v is Record<string, string> => isRecord(v),
        (d) => `Invalid: ${d}`,
      ),
    ).toBeUndefined();
  });

  test("throws for malformed JSON", () => {
    writeFileSync(filePath, "not json", "utf-8");
    expect(() =>
      readJsonFileIfExists(
        filePath,
        (v): v is Record<string, string> => isRecord(v),
        (d) => `Invalid config: ${d}`,
      ),
    ).toThrow(/Invalid config/);
  });

  test("throws for unexpected shape", () => {
    writeFileSync(filePath, '"just a string"', "utf-8");
    expect(() =>
      readJsonFileIfExists(
        filePath,
        (v): v is Record<string, string> => isRecord(v),
        (d) => `Invalid config: ${d}`,
      ),
    ).toThrow(/Invalid config/);
  });
});

describe("readJsonSchemaFileIfExists", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = join(tmpdir(), `mikan-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    filePath = join(dir, "schema.json");
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true });
  });

  test("reads and validates against schema", () => {
    writeFileSync(filePath, '{"name": "test"}', "utf-8");
    const schema = Type.Object({ name: Type.String() });
    const result = readJsonSchemaFileIfExists(
      filePath,
      schema,
      (d) => `Schema validation failed: ${d}`,
    );
    expect(result).toEqual({ name: "test" });
  });

  test("returns undefined for missing file", () => {
    const schema = Type.Object({ name: Type.String() });
    expect(
      readJsonSchemaFileIfExists(join(dir, "nonexistent.json"), schema, (d) => `Failed: ${d}`),
    ).toBeUndefined();
  });

  test("throws for schema mismatch", () => {
    writeFileSync(filePath, '{"age": 25}', "utf-8");
    const schema = Type.Object({ name: Type.String() });
    expect(() =>
      readJsonSchemaFileIfExists(filePath, schema, (d) => `Schema validation failed: ${d}`),
    ).toThrow(/Schema validation failed/);
  });
});

describe("parseJsonSchemaValue", () => {
  test("parses valid JSON matching schema", () => {
    const schema = Type.Object({ x: Type.Number() });
    const result = parseJsonSchemaValue('{"x": 1}', schema, (d) => `bad: ${d}`);
    expect(result).toEqual({ x: 1 });
  });

  test("throws for malformed JSON", () => {
    const schema = Type.Object({ x: Type.Number() });
    expect(() => parseJsonSchemaValue("not json", schema, (d) => `bad: ${d}`)).toThrow(/bad/);
  });

  test("throws for schema mismatch", () => {
    const schema = Type.Object({ x: Type.Number() });
    expect(() => parseJsonSchemaValue('{"x": "string"}', schema, (d) => `bad: ${d}`)).toThrow(
      /bad/,
    );
  });
});

describe("parseJsonValue", () => {
  test("parses valid JSON with custom validator", () => {
    const result = parseJsonValue(
      '{"valid": true}',
      (v): v is Record<string, boolean> => isRecord(v) && "valid" in v,
      (d) => `bad: ${d}`,
    );
    expect(result).toEqual({ valid: true });
  });

  test("throws for malformed JSON", () => {
    expect(() =>
      parseJsonValue(
        "broken",
        (v): v is Record<string, unknown> => isRecord(v),
        (d) => `bad: ${d}`,
      ),
    ).toThrow(/bad/);
  });

  test("throws for unexpected shape", () => {
    expect(() =>
      parseJsonValue(
        "42",
        (v): v is Record<string, unknown> => isRecord(v),
        (d) => `bad: ${d}`,
      ),
    ).toThrow(/bad/);
  });
});

describe("isRecord", () => {
  test("returns true for plain object", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ key: "value" })).toBe(true);
  });

  test("returns false for null", () => {
    expect(isRecord(null)).toBe(false);
  });

  test("returns false for array", () => {
    expect(isRecord([1, 2, 3])).toBe(false);
  });

  test("returns false for primitives", () => {
    expect(isRecord("string")).toBe(false);
    expect(isRecord(42)).toBe(false);
    expect(isRecord(true)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });
});
