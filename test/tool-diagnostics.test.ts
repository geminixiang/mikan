import { describe, expect, test } from "vitest";
import { shouldSurfaceToolDiagnostic } from "../packages/mikan/src/tool-diagnostics.js";

describe("tool diagnostic surface policy", () => {
  test("hides noisy built-in tools from chat surfaces", () => {
    expect(shouldSurfaceToolDiagnostic("bash")).toBe(false);
    expect(shouldSurfaceToolDiagnostic("read")).toBe(false);
    expect(shouldSurfaceToolDiagnostic("write")).toBe(false);
    expect(shouldSurfaceToolDiagnostic("edit")).toBe(false);
  });

  test("surfaces non-quiet tool diagnostics", () => {
    expect(shouldSurfaceToolDiagnostic("attach")).toBe(true);
    expect(shouldSurfaceToolDiagnostic("event")).toBe(true);
  });
});
