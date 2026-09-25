import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { OfficeEventStore, officeEventsDir } from "../events/index.js";
import {
  listOfficeEvents,
  readSkillsFromDir,
  resolveConversationScope,
} from "../adapters/web/admin/portal.js";
import { createOfficeAddress, createWorkspace } from "../office/index.js";
import type { AdminToken } from "../adapters/web/admin/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "mikan-admin-portal-test-"));
  tempDirs.push(dir);
  return dir;
}

function eventOffice(conversationId: string) {
  const root = makeWorkspace();
  const office = createWorkspace({
    root,
    stateDir: join(root, "..", `${conversationId}-state`),
  }).office(createOfficeAddress("slack", conversationId));
  tempDirs.push(office.workspace.stateDir);
  office.ensure();
  return office;
}

describe("admin portal events listing", () => {
  test("lists one office's events through its store, sorted by filename", async () => {
    const office = eventOffice("C123");
    const store = new OfficeEventStore(office);
    await store.create("b-reminder.json", {
      type: "one-shot",
      platform: "slack",
      conversationId: "C123",
      conversationKind: "shared",
      text: "ship it",
      at: "2099-01-01T00:00:00Z",
    });
    await store.create("a-standup.json", {
      type: "periodic",
      platform: "slack",
      conversationId: "C123",
      conversationKind: "shared",
      text: "standup",
      schedule: "0 9 * * 1-5",
      timezone: "Asia/Taipei",
    });

    const events = await listOfficeEvents(store);

    expect(events.map((e) => e.name)).toEqual(["a-standup.json", "b-reminder.json"]);
    expect(events[1]).toMatchObject({
      name: "b-reminder.json",
      officePlatform: "slack",
      officeConversationId: "C123",
      type: "one-shot",
      text: "ship it",
      at: "2099-01-01T00:00:00Z",
      schedule: null,
    });
    expect(events[0]).toMatchObject({ type: "periodic", schedule: "0 9 * * 1-5", at: null });
    expect(events[0]!.size).toBeGreaterThan(0);
    expect(events[0]!.mtimeMs).toBeGreaterThan(0);
  });

  test("keeps unparseable event files visible with null fields and the owning office", async () => {
    const office = eventOffice("C123");
    const eventsDir = officeEventsDir(office);
    mkdirSync(eventsDir, { recursive: true });
    writeFileSync(join(eventsDir, "broken.json"), "{not json");
    writeFileSync(join(eventsDir, "notes.txt"), "ignored: not a .json file");

    const events = await listOfficeEvents(new OfficeEventStore(office));

    expect(events.map((e) => e.name)).toEqual(["broken.json"]);
    expect(events[0]).toMatchObject({
      officePlatform: "slack",
      officeConversationId: "C123",
      type: null,
      platform: null,
      conversationId: null,
      text: null,
      at: null,
      schedule: null,
      timezone: null,
    });
    expect(events[0]!.size).toBeGreaterThan(0);
  });
});

function writeSkill(skillsDir: string, directory: string, contents: string): void {
  const dir = join(skillsDir, directory);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), contents);
}

describe("admin portal skills listing", () => {
  test("reads skill frontmatter via the harness parser", () => {
    const workspaceDir = makeWorkspace();
    const skillsDir = join(workspaceDir, "skills");
    writeSkill(
      skillsDir,
      "deploy",
      "---\nname: \"deploy-prod\"\ndescription: 'Ship to production'\n---\n\nInstructions here.\n",
    );

    const skills = readSkillsFromDir(skillsDir, "global");

    expect(skills).toEqual([
      {
        name: "deploy-prod",
        description: "Ship to production",
        source: "global",
        path: join(skillsDir, "deploy", "SKILL.md"),
        directory: "deploy",
      },
    ]);
  });

  test("falls back to directory name, accepts keys case-insensitively, sorts by name", () => {
    const workspaceDir = makeWorkspace();
    const skillsDir = join(workspaceDir, "skills");
    writeSkill(skillsDir, "zeta", "---\nDescription: Uppercase key still read\n---\nBody\n");
    writeSkill(skillsDir, "alpha", "no frontmatter at all\n");
    mkdirSync(join(skillsDir, "empty-dir"), { recursive: true });
    writeSkill(skillsDir, ".hidden", "---\nname: nope\ndescription: hidden\n---\n");

    const skills = readSkillsFromDir(skillsDir, "conversation");

    expect(skills.map((s) => s.name)).toEqual(["alpha", "zeta"]);
    expect(skills[0]).toMatchObject({ description: "", source: "conversation" });
    expect(skills[1]).toMatchObject({ description: "Uppercase key still read" });
  });

  test("returns empty list for a missing skills directory", () => {
    const workspaceDir = makeWorkspace();
    expect(readSkillsFromDir(join(workspaceDir, "skills"), "global")).toEqual([]);
  });
});

describe("admin conversation scope", () => {
  const token = {
    token: "t",
    platform: "slack",
    platformUserId: "U1",
    conversationId: "C123",
    expiresAt: Date.now() + 60_000,
  } as AdminToken;

  test("defaults to the token's office", () => {
    expect(resolveConversationScope("", "", token).address).toEqual(
      createOfficeAddress("slack", "C123"),
    );
  });

  test("a requested id stays on the token's platform unless one is named", () => {
    expect(resolveConversationScope("900100", "", token).address).toEqual(
      createOfficeAddress("slack", "900100"),
    );
    expect(resolveConversationScope("900100", "discord", token).address).toEqual(
      createOfficeAddress("discord", "900100"),
    );
  });

  test("rejects invalid ids and platforms without leaking a scope", () => {
    expect(resolveConversationScope("../escape", "", token).error).toBeTruthy();
    expect(resolveConversationScope("C1", "matrix", token).error).toBeTruthy();
  });
});
