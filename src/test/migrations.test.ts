import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  formatPendingMigrations,
  MIGRATIONS,
  pendingMigrations,
  readAppliedMigrations,
  recordAllMigrations,
  runMigrations,
} from "../migrations/index.js";
import type { Migration, MigrationContext } from "../migrations/types.js";
import {
  createOfficeAddress,
  listRegisteredOffices,
  officeKey,
  OfficeRegistry,
} from "../office/index.js";
import { containerCredentialKey, userCredentialKey } from "../sandbox/identity.js";
import { SessionStore } from "../sessions/session-store.js";
import type { PlatformName } from "../types.js";

let root: string;
let workspaceRoot: string;
let stateDir: string;
let piAgentDir: string;
let dockerCalls: string[][];
let containers: string[];

const DM = "D0123456789";
const CHANNEL = "C0123456789";
const dmKey = officeKey(createOfficeAddress("slack", DM));
const channelKey = officeKey(createOfficeAddress("slack", CHANNEL));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mikan-migrations-"));
  workspaceRoot = join(root, "workspace");
  stateDir = join(root, "state");
  piAgentDir = join(root, "pi-agent");
  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  dockerCalls = [];
  containers = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function context(overrides: Partial<MigrationContext> = {}): MigrationContext {
  return {
    workspaceRoot,
    stateDir,
    dryRun: false,
    owners: new Map(),
    enabledPlatforms: ["slack"],
    sandbox: { type: "image", image: "mikan-sandbox:latest" },
    piAgentDir,
    modelsPath: join(stateDir, "models.json"),
    docker: async (args) => {
      dockerCalls.push([...args]);
      return args[0] === "ps" ? `${containers.join("\n")}\n` : "";
    },
    report: () => {},
    ...overrides,
  };
}

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

function writeV3Session(officeDir: string, text: string): string {
  const name = "2026-06-01T00-00-00-000Z_11111111.jsonl";
  const header = {
    type: "session",
    version: 3,
    id: "11111111-2222-3333-4444-555555555555",
    timestamp: "2026-06-01T00:00:00.000Z",
    cwd: "/workspace",
  };
  const message = {
    type: "message",
    id: "a1",
    parentId: null,
    timestamp: "2026-06-01T00:00:01.000Z",
    message: { role: "user", content: [{ type: "text", text }], timestamp: 1 },
  };
  write(
    join(officeDir, "sessions", name),
    `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`,
  );
  write(join(officeDir, "sessions", "current"), name);
  return name;
}

function writeRelease053State(): void {
  const dm = join(workspaceRoot, DM);
  write(join(dm, "log.jsonl"), "{}\n");
  writeV3Session(dm, "remember oranges");
  write(join(dm, "settings.json"), '{"llm":{"model":"m"}}\n');
  write(join(workspaceRoot, CHANNEL, "log.jsonl"), "{}\n");
  write(join(workspaceRoot, "MEMORY.md"), "memory\n");
  mkdirSync(join(workspaceRoot, "skills"));
  write(
    join(workspaceRoot, "events", "one-shot-1.json"),
    JSON.stringify({
      platform: "slack",
      conversationId: DM,
      conversationKind: "direct",
      userId: "U0123456789",
      text: "check",
      type: "one-shot",
      at: "2026-10-06T09:00:00+08:00",
    }),
  );
  write(join(stateDir, "vaults", DM.toLowerCase(), "env"), "TOKEN=x\n");
  write(join(piAgentDir, "models.json"), '{"providers":{}}\n');
  containers = [`mikan-sandbox-${DM.toLowerCase()}`, `mikan-sandbox-${dmKey}`, "unrelated"];
}

describe("migrating a 0.5.3 state directory", () => {
  test("moves every legacy file to its current home and records each migration", async () => {
    writeRelease053State();

    const ran = await runMigrations(context());

    expect(ran).toEqual(MIGRATIONS.map((migration) => migration.id));
    expect(
      listRegisteredOffices(stateDir)
        .map((office) => officeKey(office))
        .toSorted(),
    ).toEqual([channelKey, dmKey].toSorted());
    expect(existsSync(join(workspaceRoot, DM))).toBe(false);
    expect(readFileSync(join(stateDir, "vaults", dmKey, "env"), "utf-8")).toBe("TOKEN=x\n");
    expect(existsSync(join(workspaceRoot, dmKey, "settings.json"))).toBe(false);
    expect(readFileSync(join(stateDir, "conversations", dmKey, "settings.json"), "utf-8")).toBe(
      '{"llm":{"model":"m"}}\n',
    );
    expect(readdirSync(join(stateDir, "conversations", dmKey, "events"))).toEqual([
      "one-shot-1.json",
    ]);
    expect(existsSync(join(workspaceRoot, "events"))).toBe(false);
    expect(dockerCalls).toContainEqual(["rm", "-f", `mikan-sandbox-${DM.toLowerCase()}`]);
    expect(dockerCalls.filter((call) => call[0] === "rm")).toHaveLength(1);
    expect(readFileSync(join(stateDir, "models.json"), "utf-8")).toBe('{"providers":{}}\n');
    expect(readAppliedMigrations(stateDir).map((entry) => entry.id)).toEqual(ran);
  });

  test("converts the v3 session in place and keeps a backup", async () => {
    writeRelease053State();

    await runMigrations(context());

    const sessions = join(workspaceRoot, dmKey, "sessions");
    const file = join(sessions, readFileSync(join(sessions, "current"), "utf-8").trim());
    expect(existsSync(`${file}.v3.bak`)).toBe(true);
    const store = await SessionStore.open(file);
    const built = await store.buildSessionContext();
    expect(JSON.stringify(built.messages)).toContain("remember oranges");
  });

  test("a second run finds nothing pending and changes nothing", async () => {
    writeRelease053State();
    await runMigrations(context());
    dockerCalls = [];

    expect(pendingMigrations(stateDir)).toEqual([]);
    expect(await runMigrations(context())).toEqual([]);
    expect(dockerCalls).toEqual([]);
  });

  test("a dry run reports the changes but writes nothing and records nothing", async () => {
    writeRelease053State();
    const lines: string[] = [];

    await runMigrations(context({ dryRun: true, report: (line) => lines.push(line) }));

    expect(existsSync(join(workspaceRoot, DM, "settings.json"))).toBe(true);
    expect(existsSync(join(stateDir, "vaults", DM.toLowerCase()))).toBe(true);
    expect(dockerCalls.filter((call) => call[0] === "rm")).toEqual([]);
    expect(pendingMigrations(stateDir)).toHaveLength(MIGRATIONS.length);
    expect(lines.join("\n")).toContain(`office ${DM} -> ${dmKey}`);
    expect(lines.join("\n")).toContain(`vault ${DM.toLowerCase()} -> ${dmKey}`);
  });
});

describe("migrating a partly upgraded state directory", () => {
  test("a dry run leaves conversation settings of registered offices in place", async () => {
    await runMigrations(context());
    rmSync(join(stateDir, "migrations.json"));
    write(join(workspaceRoot, dmKey, "log.jsonl"), "{}\n");
    write(join(workspaceRoot, dmKey, "settings.json"), "{}\n");
    new OfficeRegistry(stateDir).recordOffice(createOfficeAddress("slack", DM));

    await runMigrations(context({ dryRun: true }));
    expect(existsSync(join(workspaceRoot, dmKey, "settings.json"))).toBe(true);

    await runMigrations(context());
    expect(existsSync(join(workspaceRoot, dmKey, "settings.json"))).toBe(false);
    expect(existsSync(join(stateDir, "conversations", dmKey, "settings.json"))).toBe(true);
  });
});

describe("host and container vaults", () => {
  test("host vaults named by raw user ID move to hashed user keys", async () => {
    write(join(stateDir, "vaults", "U0123456789", "env"), "TOKEN=u\n");
    write(join(stateDir, "vaults", "shared", "team", "env"), "TOKEN=s\n");

    await runMigrations(context({ sandbox: { type: "host" } }));

    expect(
      readFileSync(join(stateDir, "vaults", userCredentialKey("U0123456789"), "env"), "utf-8"),
    ).toBe("TOKEN=u\n");
    expect(existsSync(join(stateDir, "vaults", "U0123456789"))).toBe(false);
    expect(existsSync(join(stateDir, "vaults", "shared", "team", "env"))).toBe(true);
  });

  test("the configured container's vault moves to its hashed container key", async () => {
    write(join(stateDir, "vaults", "container-dev", "env"), "TOKEN=c\n");
    write(join(stateDir, "vaults", "U0123456789", "env"), "TOKEN=u\n");

    await runMigrations(context({ sandbox: { type: "container", container: "dev" } }));

    expect(existsSync(join(stateDir, "vaults", containerCredentialKey("dev"), "env"))).toBe(true);
    expect(existsSync(join(stateDir, "vaults", "U0123456789"))).toBe(true);
  });
});

describe("office ownership", () => {
  test("a directory name that fits several enabled platforms needs an explicit owner", async () => {
    write(join(workspaceRoot, "123456", "log.jsonl"), "{}\n");
    const enabledPlatforms: PlatformName[] = ["telegram", "discord"];

    await expect(runMigrations(context({ enabledPlatforms }))).rejects.toThrow(
      /123456[\s\S]*--owner <conversationId>=<platform>/,
    );
    expect(pendingMigrations(stateDir)).toHaveLength(MIGRATIONS.length);

    await runMigrations(context({ enabledPlatforms, owners: new Map([["123456", "discord"]]) }));
    expect(listRegisteredOffices(stateDir).map((office) => office.platform)).toEqual(["discord"]);
  });

  test("a legacy directory whose office directory already exists stops the migration", async () => {
    write(join(workspaceRoot, DM, "log.jsonl"), "{}\n");
    write(join(workspaceRoot, dmKey, "log.jsonl"), "{}\n");

    await expect(runMigrations(context())).rejects.toThrow(/merge/);
    expect(existsSync(join(workspaceRoot, DM))).toBe(true);
  });
});

describe("the migration record", () => {
  test("stops at the failing migration and keeps the earlier ones applied", async () => {
    const order: string[] = [];
    const step = (id: string, fail = false): Migration => ({
      id,
      summary: id,
      async run() {
        order.push(id);
        if (fail) throw new Error(`${id} failed`);
      },
    });
    const migrations = [step("0001-a"), step("0002-b", true), step("0003-c")];

    await expect(runMigrations(context(), migrations)).rejects.toThrow("0002-b failed");

    expect(order).toEqual(["0001-a", "0002-b"]);
    expect(pendingMigrations(stateDir, migrations).map((migration) => migration.id)).toEqual([
      "0002-b",
      "0003-c",
    ]);
  });

  test("recording every migration leaves nothing pending for a new state directory", () => {
    recordAllMigrations(stateDir);

    expect(pendingMigrations(stateDir)).toEqual([]);
  });

  test("the startup message names each pending migration and the exact command", () => {
    const message = formatPendingMigrations({
      pending: MIGRATIONS.slice(0, 1),
      stateDir,
      workspaceRoot,
      sandbox: { type: "container", container: "dev" },
    });

    expect(message).toContain("0001-office-layout");
    expect(message).toContain(
      `mikan migrate --state-dir ${stateDir} --workspace ${workspaceRoot} --sandbox container:dev --dry-run`,
    );
  });
});
