import { describe, expect, test } from "vitest";
import {
  parseGithubPolicy,
  permissionMeets,
  repoIsAllowed,
  userIsAllowed,
  type GithubPolicyEnv,
} from "../adapters/github/policy.js";

function env(overrides: Partial<GithubPolicyEnv> = {}): GithubPolicyEnv {
  return {
    repos: "acme/widgets",
    publicRepos: undefined,
    users: undefined,
    minPermission: undefined,
    triggers: undefined,
    capabilities: undefined,
    ...overrides,
  };
}

describe("parseGithubPolicy", () => {
  test("defaults answer write-permission users on every trigger with no extra capabilities", () => {
    const policy = parseGithubPolicy(env({ repos: " Acme/Widgets , acme/* " }));
    expect(policy).toEqual({
      repos: ["acme/widgets", "acme/*"],
      publicRepos: false,
      users: null,
      minPermission: "write",
      triggers: new Set(["mention", "assign", "review", "followup"]),
      capabilities: new Set(),
    });
  });

  test("reads every restriction", () => {
    const policy = parseGithubPolicy(
      env({
        publicRepos: "true",
        users: "Alice,bob",
        minPermission: "maintain",
        triggers: "mention",
        capabilities: "triage, push",
      }),
    );
    expect(policy.publicRepos).toBe(true);
    expect(policy.users).toEqual(["alice", "bob"]);
    expect(policy.minPermission).toBe("maintain");
    expect(policy.triggers).toEqual(new Set(["mention"]));
    expect(policy.capabilities).toEqual(new Set(["triage", "push"]));
  });

  test.each([
    [{ repos: undefined }, /at least one owner\/repo/],
    [{ repos: "acme" }, /invalid entries acme/],
    [{ repos: "*/*" }, /invalid entries/],
    [{ publicRepos: "yes" }, /GITHUB_PUBLIC_REPOS must be true or false/],
    [{ minPermission: "read" }, /GITHUB_MIN_PERMISSION must be one of write, maintain, admin/],
    [{ triggers: "mention,label" }, /GITHUB_TRIGGERS has unknown value\(s\) label/],
    [{ capabilities: "merge" }, /GITHUB_CAPABILITIES has unknown value\(s\) merge/],
  ])("rejects %o", (overrides, message) => {
    expect(() => parseGithubPolicy(env(overrides))).toThrow(message);
  });
});

describe("policy checks", () => {
  const policy = parseGithubPolicy(env({ repos: "acme/widgets,tools/*", users: "alice" }));

  test("repositories match exactly or by owner wildcard, case-insensitively", () => {
    expect(repoIsAllowed(policy, { owner: "Acme", repo: "Widgets", private: true })).toBe(true);
    expect(repoIsAllowed(policy, { owner: "acme", repo: "gears", private: true })).toBe(false);
    expect(repoIsAllowed(policy, { owner: "tools", repo: "anything", private: true })).toBe(true);
    expect(repoIsAllowed(policy, { owner: "acme", repo: "widgets", private: false })).toBe(false);
  });

  test("users match case-insensitively", () => {
    expect(userIsAllowed(policy, "Alice")).toBe(true);
    expect(userIsAllowed(policy, "bob")).toBe(false);
  });

  test("permission uses the stronger of role name and legacy permission", () => {
    expect(permissionMeets(policy, { permission: "write" })).toBe(true);
    expect(permissionMeets(policy, { permission: "read", role_name: "maintain" })).toBe(true);
    expect(permissionMeets(policy, { permission: "read", role_name: "custom" })).toBe(false);
  });
});
