import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createOfficeAddress, createWorkspace, officeKey } from "../office/index.js";
import {
  conversationPackageSkillMounts,
  packageSkillRuntimeDir,
  resolveConversationPackages,
} from "../packages/index.js";

const CONVERSATION_ID = "C03045VJJAY";
const CONVERSATION_ADDRESS = createOfficeAddress("slack", CONVERSATION_ID);

let base: string;
let stateDir: string;
let workingDir: string;

function writeSettings(path: string, value: object): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function globalPackages(packages: string[]): void {
  writeSettings(join(stateDir, "settings.json"), {
    llm: { provider: "anthropic", model: "claude-sonnet-4-6", thinkingLevel: "off" },
    packages,
  });
}

/** A package shipping a skill that carries an asset next to its SKILL.md. */
function makeSkillPackage(): string {
  const repo = mkdtempSync(join(base, "repo-"));
  const skill = join(repo, "skills", "triage");
  mkdirSync(skill, { recursive: true });
  writeFileSync(
    join(skill, "SKILL.md"),
    "---\nname: triage\ndescription: Triage issues\n---\nrun ./triage.sh",
  );
  writeFileSync(join(skill, "triage.sh"), "#!/bin/sh\necho triage");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "i"], {
    cwd: repo,
  });
  return `file://${repo}`;
}

function options() {
  return {
    office: createWorkspace({ root: workingDir, stateDir }).office(CONVERSATION_ADDRESS),
  };
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "mikan-pkg-mounts-"));
  stateDir = join(base, "state");
  workingDir = join(base, "workspace");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(workingDir, officeKey(CONVERSATION_ADDRESS)), { recursive: true });
  process.env.MIKAN_STATE_DIR = stateDir;
  globalPackages([]);
});

afterEach(() => {
  delete process.env.MIKAN_STATE_DIR;
  rmSync(base, { recursive: true, force: true });
});

describe("conversationPackageSkillMounts", () => {
  test("mounts a package's skills read-only", () => {
    const source = makeSkillPackage();
    globalPackages([source]);
    resolveConversationPackages({ ...options(), fetchMissing: true });

    const mounts = conversationPackageSkillMounts(options());
    expect(mounts).toHaveLength(1);
    expect(mounts[0].readOnly).toBe(true);
    expect(mounts[0].source.endsWith("skills")).toBe(true);
  });

  test("mount targets live outside /workspace so full mode cannot shadow them", () => {
    globalPackages([makeSkillPackage()]);
    resolveConversationPackages({ ...options(), fetchMissing: true });

    const [mount] = conversationPackageSkillMounts(options());
    expect(mount.target.startsWith("/workspace")).toBe(false);
    expect(mount.target.startsWith("/mikan/packages/")).toBe(true);
    expect(mount.target.endsWith("/skills")).toBe(true);
  });

  test("the mount target matches the runtime dir the prompt will reference", () => {
    globalPackages([makeSkillPackage()]);
    const resolved = resolveConversationPackages({ ...options(), fetchMissing: true });

    const [mount] = conversationPackageSkillMounts(options());
    expect(mount.target).toBe(packageSkillRuntimeDir(resolved.skillDirs[0].slug));
  });

  test("a package without skills contributes no mount", () => {
    const repo = mkdtempSync(join(base, "repo-noskills-"));
    writeFileSync(join(repo, "index.mjs"), "export function activate() {}");
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "i"], {
      cwd: repo,
    });
    globalPackages([`file://${repo}`]);
    resolveConversationPackages({ ...options(), fetchMissing: true });

    expect(conversationPackageSkillMounts(options())).toEqual([]);
  });

  test("building the mount list never reaches the network", () => {
    // Declared but never fetched: an offline resolve yields no mounts rather
    // than blocking a container start on a clone.
    globalPackages([makeSkillPackage()]);
    expect(conversationPackageSkillMounts(options())).toEqual([]);
  });

  test("two long identities sharing a prefix get distinct mount targets", () => {
    // A slug that only truncated would collide here, silently mounting one
    // package's skills over the other's.
    const deep = join(base, "a".repeat(120));
    const repos = ["one", "two"].map((name) => {
      const repo = join(deep, name);
      mkdirSync(join(repo, "skills", "s"), { recursive: true });
      writeFileSync(
        join(repo, "skills", "s", "SKILL.md"),
        `---\nname: ${name}\ndescription: d\n---\nb`,
      );
      execFileSync("git", ["init", "-q"], { cwd: repo });
      execFileSync("git", ["add", "-A"], { cwd: repo });
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "i"], {
        cwd: repo,
      });
      return `file://${repo}`;
    });
    globalPackages(repos);
    resolveConversationPackages({ ...options(), fetchMissing: true });

    const mounts = conversationPackageSkillMounts(options());
    expect(mounts).toHaveLength(2);
    expect(mounts[0].target).not.toBe(mounts[1].target);
  });

  test("assets shipped beside SKILL.md are inside the mounted directory", () => {
    globalPackages([makeSkillPackage()]);
    const resolved = resolveConversationPackages({ ...options(), fetchMissing: true });
    const [mount] = conversationPackageSkillMounts(options());

    // The whole skills/ tree is mounted, so triage.sh is reachable at a
    // runtime path — the thing inlining a SKILL.md body could never provide.
    expect(resolved.skillDirs[0].dir).toBe(mount.source);
    expect(`${mount.target}/triage/triage.sh`).toBe(
      `${packageSkillRuntimeDir(resolved.skillDirs[0].slug)}/triage/triage.sh`,
    );
  });
});
