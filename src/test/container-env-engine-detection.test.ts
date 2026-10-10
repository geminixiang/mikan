import { expect, test, vi } from "vitest";

const detect = vi.hoisted(() => vi.fn(() => "docker"));
vi.mock("../sandbox/engine.js", () => ({ containerEngine: detect }));

const { createContainerExecutionEnv } = await import("../sandbox/container.js");

test("creating a container environment does not detect the engine", () => {
  createContainerExecutionEnv({ container: "mikan-sandbox", cwd: "/workspace" });

  expect(detect).not.toHaveBeenCalled();
});
