import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, test } from "vitest";
import { loadSubagentProfiles } from "../harness/subagent-profiles.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function emptyWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "mikan-subagent-profiles-"));
  dirs.push(dir);
  return dir;
}

function workspace(): string {
  const dir = emptyWorkspace();
  mkdirSync(join(dir, "agents"), { recursive: true });
  return dir;
}

function writeProfile(dir: string, name: string, contents: string): void {
  writeFileSync(join(dir, "agents", `${name}.md`), contents);
}

describe("loadSubagentProfiles", () => {
  test("provides safe built-ins when the runtime workspace has no profiles", () => {
    const { profiles, diagnostics } = loadSubagentProfiles(emptyWorkspace());

    expect(diagnostics).toEqual([]);
    expect(profiles.get("worker")).toMatchObject({
      tools: ["read", "bash", "edit", "write"],
      requiredTools: ["read", "bash"],
      maxTurns: 30,
    });
    expect(profiles.get("software-engineer")).toMatchObject({
      tools: ["read", "bash", "edit", "write"],
      requiredTools: ["read", "bash"],
      maxTurns: 35,
    });
    expect(profiles.get("devops-engineer")).toMatchObject({
      tools: ["read", "bash", "edit", "write", "event", "sandbox"],
      requiredTools: ["read", "bash", "sandbox"],
      maxTurns: 40,
    });
    expect(profiles.get("data-scientist")).toMatchObject({
      tools: ["read", "bash", "write"],
      requiredTools: ["read", "bash"],
      maxTurns: 35,
    });
    expect(profiles.get("account-manager")).toMatchObject({
      tools: ["read", "bash", "write", "event"],
      requiredTools: ["read", "bash"],
      maxTurns: 30,
    });
    expect(profiles.get("business-development")).toMatchObject({
      tools: ["read", "bash", "write"],
      requiredTools: ["read", "bash"],
      maxTurns: 30,
    });
    expect(profiles.get("creative-producer")).toMatchObject({
      tools: ["read", "bash", "write"],
      requiredTools: ["read", "bash", "write"],
      maxTurns: 40,
    });
    expect(profiles.get("ad-operations-specialist")).toMatchObject({
      tools: ["read", "bash", "write"],
      requiredTools: ["read", "bash"],
      maxTurns: 35,
    });
    expect(profiles.get("analysis-only")).toMatchObject({ tools: [], requiredTools: [] });
    for (const profile of profiles.values()) {
      expect(profile.maxTokens).toBe(100_000);
    }
  });

  test("built-ins pin no model, so they inherit the session's", () => {
    for (const profile of loadSubagentProfiles(emptyWorkspace()).profiles.values()) {
      expect(profile.model).toBeUndefined();
    }
  });

  test("ignores pi-coding-agent profiles", () => {
    const dir = workspace();
    mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
    writeFileSync(join(dir, ".pi", "agents", "pi-only.md"), `---\ntools: read\n---\nPi only.\n`);

    expect(loadSubagentProfiles(dir).profiles.has("pi-only")).toBe(false);
  });

  test("a model-only file patches the built-in without restating it", () => {
    const dir = workspace();
    writeProfile(dir, "software-engineer", `---\nmodel: openai-codex/gpt-5.6-luna\n---\n`);

    const profile = loadSubagentProfiles(dir).profiles.get("software-engineer");

    expect(profile).toMatchObject({
      model: { provider: "openai-codex", id: "gpt-5.6-luna" },
      tools: ["read", "bash", "edit", "write"],
      requiredTools: ["read", "bash"],
      thinkingLevel: "high",
    });
    expect(profile?.systemPrompt).toContain("software engineer");
  });

  test("a patch can narrow the built-in's tool grant", () => {
    const dir = workspace();
    writeProfile(dir, "software-engineer", `---\ntools: read\nrequired_tools: read\n---\n`);

    expect(loadSubagentProfiles(dir).profiles.get("software-engineer")).toMatchObject({
      tools: ["read"],
      requiredTools: ["read"],
    });
  });

  test("defines a new profile with tools, budgets, and prompt", () => {
    const dir = workspace();
    writeProfile(
      dir,
      "auditor",
      `---\ndescription: Evidence auditor\ntools: read, bash\nrequired_tools: read\nmodel: openai-codex/gpt-5.6-luna\nthinking: high\nmax_turns: 12\nmax_tokens: 90000\nmax_cost_usd: 0.75\nmax_duration_ms: 120000\n---\nUse evidence only.\n`,
    );

    expect(loadSubagentProfiles(dir).profiles.get("auditor")).toEqual({
      name: "auditor",
      description: "Evidence auditor",
      systemPrompt: "Use evidence only.",
      tools: ["read", "bash"],
      requiredTools: ["read"],
      model: { provider: "openai-codex", id: "gpt-5.6-luna" },
      thinkingLevel: "high",
      maxTurns: 12,
      maxTokens: 90_000,
      maxCostUsd: 0.75,
      maxDurationMs: 120_000,
    });
  });

  test("reads `none` as an empty tool grant", () => {
    const dir = workspace();
    writeProfile(dir, "reader", `---\ntools: none\nrequired_tools: none\n---\nThink only.\n`);

    expect(loadSubagentProfiles(dir).profiles.get("reader")).toMatchObject({
      tools: [],
      requiredTools: [],
    });
  });

  test("reports required tools outside the grant and keeps the built-in", () => {
    const dir = workspace();
    writeProfile(dir, "software-engineer", `---\ntools: read\nrequired_tools: bash\n---\n`);

    const { profiles, diagnostics } = loadSubagentProfiles(dir);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("required_tools must be included in tools: bash");
    expect(profiles.get("software-engineer")).toMatchObject({
      tools: ["read", "bash", "edit", "write"],
    });
  });

  test("one malformed file never takes the whole workspace down", () => {
    const dir = workspace();
    writeProfile(dir, "broken", `---\ntools: read\nmodel: no-slash-here\n---\nBroken.\n`);
    writeProfile(dir, "fine", `---\ntools: read\n---\nFine.\n`);

    const { profiles, diagnostics } = loadSubagentProfiles(dir);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("model must be provider/id");
    expect(profiles.has("broken")).toBe(false);
    expect(profiles.get("fine")).toMatchObject({ tools: ["read"] });
    expect(profiles.get("analysis-only")).toBeDefined();
  });

  test("reports a new profile that supplies no tools", () => {
    const dir = workspace();
    writeProfile(dir, "vague", `---\ndescription: No grant\n---\nDo something.\n`);

    const { profiles, diagnostics } = loadSubagentProfiles(dir);

    expect(diagnostics[0].message).toContain("tools is required for a new profile");
    expect(profiles.has("vague")).toBe(false);
  });

  test("reports a new profile with an empty body", () => {
    const dir = workspace();
    writeProfile(dir, "empty", `---\ntools: read\n---\n`);

    const { profiles, diagnostics } = loadSubagentProfiles(dir);

    expect(diagnostics[0].message).toContain("needs prompt text in the file body");
    expect(profiles.has("empty")).toBe(false);
  });

  test("reports an unusable budget", () => {
    const dir = workspace();
    writeProfile(dir, "software-engineer", `---\nmax_cost_usd: -1\n---\n`);

    expect(loadSubagentProfiles(dir).diagnostics[0].message).toContain(
      "max_cost_usd must be a non-negative number",
    );
  });
});
