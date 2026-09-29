import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mikan-cli-migrate-"));
  roots.push(root);
  return root;
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
    ["--sandbox", "host", "extra"],
    ["--sandbox", "host", "--workspace"],
    ["--sandbox", "host", "--owner", "C123"],
    ["--sandbox", "host", "--owner", "C123=matrix"],
    [],
  ])("rejects invalid arguments: %j", async (...args) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runMigrateCommand(args, missingDocker)).toBe(1);
  });

  test("applies every migration to an empty state directory, then has nothing pending", async () => {
    const root = tempRoot();
    const stateDir = join(root, "state");
    mkdirSync(stateDir);
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const args = [
      "--state-dir",
      stateDir,
      "--workspace",
      join(root, "workspace"),
      "--sandbox",
      "image:mikan-sandbox:latest",
    ];

    expect(await runMigrateCommand(args, missingDocker)).toBe(0);
    expect(output).toHaveBeenCalledWith(`Applied ${MIGRATIONS.length}.`);
    expect(pendingMigrations(stateDir)).toEqual([]);

    expect(await runMigrateCommand(args, missingDocker)).toBe(0);
    expect(output).toHaveBeenLastCalledWith("No pending migrations.");
  });

  test("a failing migration exits non-zero and names the problem", async () => {
    const root = tempRoot();
    const stateDir = join(root, "state");
    const workspace = join(root, "workspace");
    mkdirSync(join(workspace, "123456"), { recursive: true });
    writeFileSync(join(workspace, "123456", "log.jsonl"), "{}\n");
    mkdirSync(stateDir);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runMigrateCommand(
      ["--state-dir", stateDir, "--workspace", workspace, "--sandbox", "host"],
      missingDocker,
    );

    expect(code).toBe(1);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("123456"));
  });
});

describe("mikan office list", () => {
  test("prints each office key with its platform and conversation id", () => {
    const stateDir = join(tempRoot(), "state");
    const address = createOfficeAddress("slack", "C0123456789");
    new OfficeRegistry(stateDir).recordOffice(address);
    const output = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(runOfficeCommand(["list", "--state-dir", stateDir])).toBe(0);
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
