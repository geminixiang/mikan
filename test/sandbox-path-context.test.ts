import { describe, expect, test } from "vitest";
import { createMountedRuntimePathContext } from "../src/sandbox/path-context.js";

describe("createMountedRuntimePathContext", () => {
  const pathContext = createMountedRuntimePathContext("/host/workspace", "/workspace");

  test("translates the workspace root and normalized descendants", () => {
    expect(pathContext.runtimeToHostPath?.("/workspace")).toBe("/host/workspace");
    expect(pathContext.runtimeToHostPath?.("/workspace/C123/../report.txt")).toBe(
      "/host/workspace/report.txt",
    );
  });

  test("does not translate traversal outside the runtime workspace", () => {
    expect(pathContext.runtimeToHostPath?.("/workspace/../outside.txt")).toBe(
      "/workspace/../outside.txt",
    );
    expect(pathContext.runtimeToHostPath?.("/workspace/C123/../../outside.txt")).toBe(
      "/workspace/C123/../../outside.txt",
    );
  });

  test("does not translate a sibling runtime path with a shared prefix", () => {
    expect(pathContext.runtimeToHostPath?.("/workspace-sibling/report.txt")).toBe(
      "/workspace-sibling/report.txt",
    );
  });
});
