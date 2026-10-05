import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { readEnv } from "../env-manifest.js";

describe("readEnv", () => {
  beforeEach(() => {
    process.env.TEST_VAR = "hello";
    process.env.MIKAN_TEST_VAR = "world";
  });

  afterEach(() => {
    delete process.env.TEST_VAR;
    delete process.env.MIKAN_TEST_VAR;
  });

  test("reads direct env var", () => {
    expect(readEnv("TEST_VAR")).toBe("hello");
  });

  test("reads prefixed env var when direct is empty", () => {
    delete process.env.TEST_VAR;
    expect(readEnv("TEST_VAR")).toBe("world");
  });

  test("returns undefined when neither direct nor prefixed exist", () => {
    expect(readEnv("NONEXISTENT")).toBeUndefined();
  });

  test("returns undefined for empty string after trim", () => {
    process.env.TEST_VAR = "  ";
    delete process.env.MIKAN_TEST_VAR;
    expect(readEnv("TEST_VAR")).toBeUndefined();
  });
});
