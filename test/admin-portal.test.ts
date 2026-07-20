import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resolveConversationStorage } from "../src/sessions/conversation-storage.js";
import { HostEventStore } from "../src/tools/event.js";
import {
  listAdminConversationScopes,
  listAllEvents,
  readSkillsFromDir,
  resolveAdminConversationScope,
} from "../src/web/admin/portal.js";
import type { AdminServices } from "../src/web/admin/types.js";

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

describe("admin conversation catalog", () => {
  test("keeps identical Discord and Telegram ids as distinct admin scopes", async () => {
    const workspaceDir = makeWorkspace();
    await Promise.all([
      resolveConversationStorage({
        workspaceRoot: workspaceDir,
        platform: "discord",
        conversationId: "123",
        activePlatforms: ["discord", "telegram"],
      }),
      resolveConversationStorage({
        workspaceRoot: workspaceDir,
        platform: "telegram",
        conversationId: "123",
        activePlatforms: ["discord", "telegram"],
      }),
    ]);

    const scopes = listAdminConversationScopes(workspaceDir, {
      conversationStorageScoped: true,
    } as AdminServices);

    expect(scopes.map(({ scopeKey }) => scopeKey)).toEqual(["discord:123", "telegram:123"]);
    expect(scopes[0].conversationDir).not.toBe(scopes[1].conversationDir);

    const token = {
      platform: "discord",
      conversationId: "123",
    } as Parameters<typeof resolveAdminConversationScope>[1];
    expect(
      resolveAdminConversationScope("telegram:123", token, {
        workingDir: workspaceDir,
        conversationStorageScoped: true,
      } as AdminServices).scope,
    ).toMatchObject({
      platform: "telegram",
      conversationId: "123",
      scopeKey: "telegram:123",
    });
    expect(
      resolveAdminConversationScope("123", token, {
        workingDir: workspaceDir,
        conversationStorageScoped: true,
      } as AdminServices).error,
    ).toBe("Invalid conversation scope.");
  });
});

describe("admin portal events listing", () => {
  test("lists events through HostEventStore, sorted by filename", async () => {
    const workspaceDir = makeWorkspace();
    const store = HostEventStore.fromWorkspaceDir(workspaceDir);
    await store.write("b-reminder.json", {
      type: "one-shot",
      platform: "slack",
      conversationId: "C123",
      conversationKind: "shared",
      text: "ship it",
      at: "2099-01-01T00:00:00Z",
    });
    await store.write("a-standup.json", {
      type: "periodic",
      platform: "slack",
      conversationId: "C456",
      conversationKind: "shared",
      text: "standup",
      schedule: "0 9 * * 1-5",
      timezone: "Asia/Taipei",
    });

    const events = await listAllEvents(store);

    expect(events.map((e) => e.name)).toEqual(["a-standup.json", "b-reminder.json"]);
    expect(events[1]).toMatchObject({
      name: "b-reminder.json",
      type: "one-shot",
      platform: "slack",
      conversationId: "C123",
      text: "ship it",
      at: "2099-01-01T00:00:00Z",
      schedule: null,
      timezone: null,
    });
    expect(events[0]).toMatchObject({
      type: "periodic",
      conversationId: "C456",
      schedule: "0 9 * * 1-5",
      timezone: "Asia/Taipei",
      at: null,
    });
    expect(events[0].size).toBeGreaterThan(0);
    expect(events[0].mtimeMs).toBeGreaterThan(0);
  });

  test("normalizes the legacy channelId alias through the store", async () => {
    const workspaceDir = makeWorkspace();
    const eventsDir = join(workspaceDir, "events");
    mkdirSync(eventsDir, { recursive: true });
    writeFileSync(
      join(eventsDir, "legacy.json"),
      JSON.stringify({
        type: "immediate",
        platform: "slack",
        channelId: "C-LEGACY",
        text: "old-style event",
      }),
    );

    const events = await listAllEvents(HostEventStore.fromWorkspaceDir(workspaceDir));

    expect(events).toHaveLength(1);
    expect(events[0].conversationId).toBe("C-LEGACY");
    expect(events[0].type).toBe("immediate");
    expect(events[0].text).toBe("old-style event");
  });

  test("keeps unparseable event files visible with null fields", async () => {
    const workspaceDir = makeWorkspace();
    const eventsDir = join(workspaceDir, "events");
    mkdirSync(eventsDir, { recursive: true });
    writeFileSync(join(eventsDir, "broken.json"), "{not json");
    writeFileSync(join(eventsDir, "notes.txt"), "ignored: not a .json file");

    const events = await listAllEvents(HostEventStore.fromWorkspaceDir(workspaceDir));

    expect(events.map((e) => e.name)).toEqual(["broken.json"]);
    expect(events[0]).toMatchObject({
      type: null,
      platform: null,
      conversationId: null,
      text: null,
      at: null,
      schedule: null,
      timezone: null,
    });
    expect(events[0].size).toBeGreaterThan(0);
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
    // Directories without SKILL.md and hidden directories are skipped.
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
