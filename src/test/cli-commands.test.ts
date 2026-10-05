import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { runMigrateCommand } from "../cli/migrate.js";
import { runOfficeCommand } from "../cli/office.js";
import { MIGRATIONS, pendingMigrations } from "../migrations/index.js";
import { createOfficeAddress, officeKey, OfficeRegistry } from "../office/index.js";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mikan-cli-migrate-"));
  roots.push(root);
  return root;
}

function homeStateDir(root: string): string {
  vi.stubEnv("HOME", root);
  return join(root, ".mikan");
}

function legacyInstall(root: string): { stateDir: string; workspace: string } {
  const stateDir = homeStateDir(root);
  const workspace = join(root, "workspace");
  mkdirSync(stateDir);
  mkdirSync(workspace);
  writeFileSync(join(stateDir, "settings.json"), "{}");
  return { stateDir, workspace };
}

async function missingDocker(): Promise<string> {
  throw Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" });
}

describe("mikan migrate", () => {
  test("help is generated from its options without running migrations", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await runMigrateCommand(["--help"], missingDocker)).toBe(0);
    expect(output).toHaveBeenCalledWith(expect.stringContaining("--dry-run"));
    expect(output).toHaveBeenCalledWith(expect.stringContaining("--owner"));
  });

  test.each([
    ["--sandbox", "host", "--state-dir", "/tmp/state"],
    ["--sandbox", "host", "extra"],
    ["--sandbox", "host", "--workspace"],
    ["--sandbox", "host", "--owner", "C123"],
    ["--sandbox", "host", "--owner", "C123=matrix"],
    [],
  ])("rejects invalid arguments: %j", async (...args) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runMigrateCommand(args, missingDocker)).toBe(1);
  });

  test("applies every migration to an install with nothing to convert, then has nothing pending", async () => {
    const { stateDir, workspace } = legacyInstall(tempRoot());
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const args = ["--workspace", workspace, "--sandbox", "image:mikan-sandbox:latest"];

    expect(await runMigrateCommand(args, missingDocker)).toBe(0);
    expect(output).toHaveBeenCalledWith(`Applied ${MIGRATIONS.length}.`);
    expect(pendingMigrations(stateDir)).toEqual([]);

    expect(await runMigrateCommand(args, missingDocker)).toBe(0);
    expect(output).toHaveBeenLastCalledWith("No pending migrations.");
  });

  test("copies Pi's models.json into the chosen state directory", async () => {
    const root = tempRoot();
    const { stateDir, workspace } = legacyInstall(root);
    const piAgentDir = join(root, "pi-agent");
    mkdirSync(piAgentDir);
    writeFileSync(join(piAgentDir, "models.json"), '{"providers":{}}');
    vi.stubEnv("PI_CODING_AGENT_DIR", piAgentDir);
    vi.spyOn(console, "log").mockImplementation(() => {});

    const args = ["--workspace", workspace];
    expect(await runMigrateCommand([...args, "--sandbox", "host"], missingDocker)).toBe(0);

    expect(readFileSync(join(stateDir, "models.json"), "utf-8")).toBe('{"providers":{}}');
  });

  test("a failing migration exits non-zero and names the problem", async () => {
    const { workspace } = legacyInstall(tempRoot());
    mkdirSync(join(workspace, "123456"));
    writeFileSync(join(workspace, "123456", "log.jsonl"), "{}\n");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runMigrateCommand(
      ["--workspace", workspace, "--sandbox", "host"],
      missingDocker,
    );

    expect(code).toBe(1);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("123456"));
  });

  test.each([[[]], [["--dry-run"]]])(
    "refuses a ~/.mikan without settings.json before touching the workspace %j",
    async (extra) => {
      const root = tempRoot();
      const stateDir = homeStateDir(root);
      const workspace = join(root, "workspace");
      mkdirSync(join(workspace, "C0123456789"), { recursive: true });
      writeFileSync(join(workspace, "C0123456789", "log.jsonl"), "{}\n");
      vi.spyOn(console, "log").mockImplementation(() => {});
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});

      const code = await runMigrateCommand(
        ["--workspace", workspace, "--sandbox", "host", ...extra],
        missingDocker,
      );

      expect(code).toBe(1);
      expect(errors).toHaveBeenCalledWith(expect.stringContaining(join(stateDir, "settings.json")));
      expect(existsSync(join(workspace, "C0123456789", "log.jsonl"))).toBe(true);
      expect(existsSync(stateDir)).toBe(false);
    },
  );

  test("refuses a workspace that does not exist and records nothing", async () => {
    const { stateDir } = legacyInstall(tempRoot());
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runMigrateCommand(["--sandbox", "host"], missingDocker);

    expect(code).toBe(1);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining(join(stateDir, "workspace")));
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("--workspace"));
    expect(pendingMigrations(stateDir)).toEqual(MIGRATIONS);
  });
});

describe("mikan office list", () => {
  test("prints each office key with its platform and conversation id", () => {
    const stateDir = homeStateDir(tempRoot());
    const address = createOfficeAddress("slack", "C0123456789");
    new OfficeRegistry(stateDir).recordOffice(address);
    const output = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(runOfficeCommand(["list"])).toBe(0);
    expect(output).toHaveBeenCalledWith(`  ${officeKey(address)}  slack  C0123456789`);
  });

  test.each([["claim", "C123", "slack"], ["list", "extra"], []])(
    "rejects removed or invalid subcommands: %j",
    (...args) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      expect(runOfficeCommand(args)).not.toBe(0);
    },
  );
});
