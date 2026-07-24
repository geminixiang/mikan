import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { configureGondolinRuntime } from "../src/sandbox/gondolin-bootstrap.js";
import { gondolinInventory } from "../src/sandbox/gondolin-inventory.js";
import { gondolinResources } from "../src/sandbox/gondolin.js";

describe("configureGondolinRuntime", () => {
  let stateDir: string | undefined;

  afterEach(() => {
    if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  });

  test("configures local resources and inventory", () => {
    stateDir = mkdtempSync(join(tmpdir(), "mikan-gondolin-bootstrap-"));

    configureGondolinRuntime({
      stateDir,
      limits: { cpus: "1", memory: "2g" },
      boostLimits: { cpus: "2", memory: "4g" },
    });

    expect(gondolinResources.getDefaultLimits()).toEqual({ cpus: "1", memory: "2g" });
    expect(gondolinResources.getBoostLimits()).toEqual({ cpus: "2", memory: "4g" });
    expect(() => gondolinInventory.touchHeartbeat()).not.toThrow();
  });
});
