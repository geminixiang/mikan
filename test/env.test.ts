import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { readEnv, setEnvAliases } from "../src/utils/env.js";

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

describe("setEnvAliases", () => {
  afterEach(() => {
    delete process.env.MY_KEY;
    delete process.env.MIKAN_MY_KEY;
  });

  test("sets both direct and prefixed env vars", () => {
    setEnvAliases("MY_KEY", "secret");
    expect(process.env.MY_KEY).toBe("secret");
    expect(process.env.MIKAN_MY_KEY).toBe("secret");
  });

  test("overwrites existing values", () => {
    process.env.MY_KEY = "old";
    process.env.MIKAN_MY_KEY = "old";
    setEnvAliases("MY_KEY", "new");
    expect(process.env.MY_KEY).toBe("new");
    expect(process.env.MIKAN_MY_KEY).toBe("new");
  });
});
