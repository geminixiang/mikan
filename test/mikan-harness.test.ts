import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../src/sandbox/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sandbox/index.js")>();
  return { ...actual, validateSandbox: vi.fn(async () => {}) };
});

vi.mock("../src/provisioner.js", () => ({
  DockerContainerManager: class {
    async reconcile(): Promise<void> {}
    async stopIdle(): Promise<void> {}
  },
}));

const { MikanHarness } = await import("../src/mikan-harness.js");

let workingDir: string;
let stateDir: string;

beforeEach(() => {
  workingDir = mkdtempSync(join(tmpdir(), "mikan-harness-working-"));
  stateDir = mkdtempSync(join(tmpdir(), "mikan-harness-state-"));
  writeFileSync(
    join(stateDir, "settings.json"),
    JSON.stringify({
      llm: { provider: "anthropic", model: "claude-sonnet-5", thinkingLevel: "off" },
    }),
  );
});

afterEach(() => {
  rmSync(workingDir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("MikanHarness.create", () => {
  test("host sandbox: no provisioner, no image directories bootstrapped", async () => {
    const mikan = await MikanHarness.create({
      workingDir,
      stateDir,
      sandbox: { type: "host" },
    });

    expect(mikan.provisioner).toBeUndefined();
    expect(mikan.runtime).toBeDefined();
    expect(mikan.vaultManager).toBeDefined();
    expect(existsSync(join(workingDir, "skills"))).toBe(false);
    expect(existsSync(join(workingDir, "events"))).toBe(false);
    expect(existsSync(join(workingDir, "MEMORY.md"))).toBe(false);
  });

  test("image sandbox: provisioner created, skills/events/MEMORY.md bootstrapped", async () => {
    const mikan = await MikanHarness.create({
      workingDir,
      stateDir,
      sandbox: { type: "image", image: "ubuntu:24.04" },
    });

    expect(mikan.provisioner).toBeDefined();
    expect(existsSync(join(workingDir, "skills"))).toBe(true);
    expect(existsSync(join(workingDir, "events"))).toBe(true);
    expect(existsSync(join(workingDir, "MEMORY.md"))).toBe(true);
  });

  test("image sandbox bootstrap does not clobber an existing MEMORY.md", async () => {
    writeFileSync(join(workingDir, "MEMORY.md"), "existing memory");

    await MikanHarness.create({
      workingDir,
      stateDir,
      sandbox: { type: "image", image: "ubuntu:24.04" },
    });

    expect(readFileSync(join(workingDir, "MEMORY.md"), "utf-8")).toBe("existing memory");
  });

  test("exposes vault/token store instances used elsewhere (e.g. web server wiring)", async () => {
    const mikan = await MikanHarness.create({ workingDir, stateDir, sandbox: { type: "host" } });

    expect(mikan.linkTokenStore).toBeDefined();
    expect(mikan.sessionViewTokenStore).toBeDefined();
    expect(mikan.adminTokenStore).toBeDefined();
  });
});
