import type {
  GithubCapability,
  GithubPolicy,
  GithubRepoRef,
  GithubTrigger,
  GithubTriggerPermission,
} from "./types.js";

const GITHUB_TRIGGERS: readonly GithubTrigger[] = ["mention", "assign", "review", "followup"];

const GITHUB_CAPABILITIES: readonly GithubCapability[] = ["triage", "push"];

const PERMISSION_RANK = {
  none: 0,
  read: 1,
  triage: 2,
  write: 3,
  maintain: 4,
  admin: 5,
};

const TRIGGER_PERMISSIONS: readonly GithubTriggerPermission[] = ["write", "maintain", "admin"];

const REPO_PATTERN = /^[\w.-]+\/(?:\*|[\w.-]+)$/;

export interface GithubPolicyEnv {
  repos: string | undefined;
  publicRepos: string | undefined;
  users: string | undefined;
  minPermission: string | undefined;
  triggers: string | undefined;
  capabilities: string | undefined;
}

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function pickAll<T extends string>(name: string, allowed: readonly T[], entries: string[]): Set<T> {
  const unknown = entries.filter((entry) => !(allowed as readonly string[]).includes(entry));
  if (unknown.length > 0) {
    throw new Error(
      `${name} has unknown value(s) ${unknown.join(", ")}; use ${allowed.join(", ")}`,
    );
  }
  return new Set(entries as T[]);
}

function parseBoolean(name: string, value: string | undefined): boolean {
  const normalized = (value ?? "false").trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`${name} must be true or false`);
}

export function parseGithubPolicy(env: GithubPolicyEnv): GithubPolicy {
  const repos = splitList(env.repos);
  if (repos.length === 0) {
    throw new Error("GITHUB_REPOS must list at least one owner/repo or owner/*");
  }
  const invalidRepos = repos.filter((entry) => !REPO_PATTERN.test(entry));
  if (invalidRepos.length > 0) {
    throw new Error(
      `GITHUB_REPOS has invalid entries ${invalidRepos.join(", ")}; use owner/repo or owner/*`,
    );
  }
  const minPermission = (env.minPermission ?? "write").trim().toLowerCase();
  if (!(TRIGGER_PERMISSIONS as readonly string[]).includes(minPermission)) {
    throw new Error(`GITHUB_MIN_PERMISSION must be one of ${TRIGGER_PERMISSIONS.join(", ")}`);
  }
  const users = splitList(env.users);
  return {
    repos,
    publicRepos: parseBoolean("GITHUB_PUBLIC_REPOS", env.publicRepos),
    users: users.length > 0 ? users : null,
    minPermission: minPermission as GithubTriggerPermission,
    triggers:
      env.triggers === undefined
        ? new Set(GITHUB_TRIGGERS)
        : pickAll("GITHUB_TRIGGERS", GITHUB_TRIGGERS, splitList(env.triggers)),
    capabilities: pickAll("GITHUB_CAPABILITIES", GITHUB_CAPABILITIES, splitList(env.capabilities)),
  };
}

export function repoIsAllowed(
  policy: GithubPolicy,
  repo: GithubRepoRef & { private: boolean },
): boolean {
  if (!repo.private && !policy.publicRepos) return false;
  const owner = repo.owner.toLowerCase();
  const name = repo.repo.toLowerCase();
  return policy.repos.some((entry) => {
    const [entryOwner, entryName] = entry.split("/");
    return entryOwner === owner && (entryName === "*" || entryName === name);
  });
}

export function userIsAllowed(policy: GithubPolicy, login: string): boolean {
  return policy.users === null || policy.users.includes(login.toLowerCase());
}

function rankOfPermission(name: string): number {
  return PERMISSION_RANK[name as keyof typeof PERMISSION_RANK] ?? 0;
}

export function permissionMeets(
  policy: GithubPolicy,
  role: { permission: string; role_name?: string },
): boolean {
  const rank = Math.max(rankOfPermission(role.role_name ?? ""), rankOfPermission(role.permission));
  return rank >= PERMISSION_RANK[policy.minPermission];
}
