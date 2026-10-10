import { describe, expect, test } from "vitest";
import { detectContainerEngine, type EngineState } from "../sandbox/engine.js";

function probeOf(states: Record<string, EngineState>) {
  const probed: string[] = [];
  const probe = (engine: string): EngineState => {
    probed.push(engine);
    return states[engine] ?? "missing";
  };
  return { probe, probed };
}

describe("detectContainerEngine", () => {
  test.each([
    [{ nerdctl: "running", podman: "running", docker: "running" }, "nerdctl"],
    [{ podman: "running", docker: "running" }, "podman"],
    [{ docker: "running" }, "docker"],
    [{ nerdctl: "installed", podman: "running" }, "podman"],
    [{ nerdctl: "installed", docker: "installed" }, "nerdctl"],
    [{}, "docker"],
  ] as const)(
    "picks the first running engine in the order nerdctl, podman, docker: %o",
    (states, picked) => {
      expect(detectContainerEngine(probeOf(states).probe)).toBe(picked);
    },
  );

  test("stops probing at the first running engine", () => {
    const { probe, probed } = probeOf({ nerdctl: "missing", podman: "running", docker: "running" });

    detectContainerEngine(probe);

    expect(probed).toEqual(["nerdctl", "podman"]);
  });
});
