import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resolveConversationPackages } from "../packages/index.js";
import { createOfficeAddress, createWorkspace, officeKey } from "../office/index.js";

const CONVERSATION_ID = "C03045VJJAY";
const CONVERSATION_ADDRESS = createOfficeAddress("slack", CONVERSATION_ID);

let base: string;
let stateDir: string;
let workingDir: string;

function writeSettings(path: string, value: object): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function globalSettings(packages: string[]): void {
  writeSettings(join(stateDir, "settings.json"), {
    llm: { provider: "anthropic", model: "claude-sonnet-4-6", thinkingLevel: "off" },
    packages,
  });
}

function conversationSettings(packages: string[]): void {
  writeSettings(join(stateDir, "conversations", officeKey(CONVERSATION_ADDRESS), "settings.json"), {
    packages,
  });
}

function makeCollectionRepo(marker: string): string {
  const repo = mkdtempSync(join(base, "repo-collection-"));
  writeFileSync(join(repo, "README.md"), marker);
  mkdirSync(join(repo, "skills", "triage"), { recursive: true });
  writeFileSync(join(repo, "skills", "triage", "SKILL.md"), "---\nname: triage\n---\nbody");
  return repo;
}

function makePackageWithoutSkills(name: string): string {
  const repo = join(base, name);
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "index.mjs"), "export function activate() {}");
  return repo;
}

function gitify(repo: string, tag?: string): string {
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], {
    cwd: repo,
  });
  if (tag) execFileSync("git", ["tag", tag], { cwd: repo });
  return `file://${repo}`;
}

function makeTwoRefRepo(): string {
  const repo = mkdtempSync(join(base, "repo-two-refs-"));
  for (const subpath of ["one", "two"]) {
    mkdirSync(join(repo, "packages", subpath), { recursive: true });
    writeFileSync(join(repo, "packages", subpath, "index.mjs"), `${subpath}-v1`);
  }
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "v1"], {
    cwd: repo,
  });
  execFileSync("git", ["tag", "v1"], { cwd: repo });
  for (const subpath of ["one", "two"]) {
    writeFileSync(join(repo, "packages", subpath, "index.mjs"), `${subpath}-v2`);
  }
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "v2"], {
    cwd: repo,
  });
  execFileSync("git", ["tag", "v2"], { cwd: repo });
  return `file://${repo}`;
}

function resolve(options?: { fetchMissing?: boolean }) {
  return resolveConversationPackages({
    office: createWorkspace({ root: workingDir, stateDir }).office(CONVERSATION_ADDRESS),
    ...options,
  });
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "mikan-pkg-resolve-"));
  stateDir = join(base, "state");
  workingDir = join(base, "workspace");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(workingDir, officeKey(CONVERSATION_ADDRESS)), { recursive: true });
  process.env.MIKAN_STATE_DIR = stateDir;
  globalSettings([]);
});

afterEach(() => {
  delete process.env.MIKAN_STATE_DIR;
  rmSync(base, { recursive: true, force: true });
});

describe("scopes are additive", () => {
  test("a conversation's packages do not replace the global ones", () => {
    const globalPkg = gitify(makeCollectionRepo("global"));
    const conversationPkg = gitify(makePackageWithoutSkills("channel-only"));
    globalSettings([globalPkg]);
    conversationSettings([conversationPkg]);

    const result = resolve({ fetchMissing: true });
    expect(result.packages).toHaveLength(2);
    expect(result.packages.map((pkg) => pkg.scope)).toEqual(["global", "conversation"]);
  });

  test("an unset conversation list does not re-load the global packages", () => {
    globalSettings([gitify(makeCollectionRepo("global"))]);
    // No conversation settings file at all.
    const result = resolve({ fetchMissing: true });
    expect(result.packages).toHaveLength(1);
    expect(result.packages[0].scope).toBe("global");
  });
});

describe("the narrower scope wins", () => {
  test("the same package in both scopes materializes once, as the conversation's", () => {
    const repo = makeCollectionRepo("shared");
    const source = gitify(repo, "v1");
    globalSettings([`${source}@v1`]);
    conversationSettings([source]);

    const result = resolve({ fetchMissing: true });
    expect(result.packages).toHaveLength(1);
    expect(result.packages[0].scope).toBe("conversation");
  });

  test("differing transport spellings still count as the same package", () => {
    const repo = makeCollectionRepo("shared");
    const source = gitify(repo);
    globalSettings([source]);
    conversationSettings([`${source}#`]); // trailing empty subpath, same identity

    const result = resolve({ fetchMissing: true });
    expect(result.packages).toHaveLength(1);
  });
});

describe("ref-keyed checkouts", () => {
  test("offline resolution keeps two refs and two subpaths isolated", () => {
    const source = makeTwoRefRepo();
    globalSettings([`${source}@v1#packages/one`, `${source}@v2#packages/two`]);

    const fetched = resolve({ fetchMissing: true });
    expect(fetched.packages).toHaveLength(2);
    expect(new Set(fetched.packages.map((pkg) => pkg.dir)).size).toBe(2);

    rmSync(source.slice("file://".length), { recursive: true, force: true });
    const offline = resolve();
    expect(offline.errors).toEqual([]);
    expect(offline.packages).toHaveLength(2);
    expect(
      offline.packages.map((pkg) => readFileSync(join(pkg.dir, "index.mjs"), "utf-8")),
    ).toEqual(expect.arrayContaining(["one-v1", "two-v2"]));
  });
});

describe("package layouts", () => {
  test("a package skills/ directory is reported with a slug", () => {
    globalSettings([gitify(makeCollectionRepo("c"))]);
    const result = resolve({ fetchMissing: true });
    expect(result.skillDirs).toHaveLength(1);
    expect(result.skillDirs[0].slug).toMatch(/^[a-z0-9._-]+$/);
    expect(result.skillDirs[0].dir.endsWith("skills")).toBe(true);
  });

  test("a package without skills/ contributes no skill dir", () => {
    globalSettings([gitify(makePackageWithoutSkills("no-skills"))]);
    expect(resolve({ fetchMissing: true }).skillDirs).toEqual([]);
  });
});

describe("failures never take a conversation down", () => {
  test("a malformed source is reported and the rest still resolve", () => {
    const good = gitify(makeCollectionRepo("good"));
    globalSettings(["not a source", good]);

    const result = resolve({ fetchMissing: true });
    expect(result.packages).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].source).toBe("not a source");
  });

  test("an unfetchable source is reported, not thrown", () => {
    globalSettings(["file:///nope/missing/repo"]);
    const result = resolve({ fetchMissing: true });
    expect(result.packages).toEqual([]);
    expect(result.errors).toHaveLength(1);
  });

  test("without fetchMissing, a not-yet-materialized package is an error, not a network call", () => {
    globalSettings([gitify(makeCollectionRepo("c"))]);
    const result = resolve();
    expect(result.packages).toEqual([]);
    expect(result.errors[0].message).toMatch(/Not fetched on this host yet/);
  });

  test("an already-materialized package resolves without fetchMissing", () => {
    globalSettings([gitify(makeCollectionRepo("c"))]);
    expect(resolve({ fetchMissing: true }).packages).toHaveLength(1);
    // Second pass with no network permission still sees it.
    expect(resolve().packages).toHaveLength(1);
  });

  test("an unreadable settings file yields no packages", () => {
    writeFileSync(join(stateDir, "settings.json"), "{ not json");
    expect(resolve().packages).toEqual([]);
  });
});
