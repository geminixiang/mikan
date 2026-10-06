import type {
  GithubCapability,
  GithubPolicy,
  GithubRepoRef,
  GithubTrigger,
  GithubTriggerPermission,
} from "./types.js";
import type { GithubSettings } from "../../settings/index.js";

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

function normalizeList(values: readonly string[] | undefined): string[] {
  return (values ?? []).map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}

function pickAll<T extends string>(key: string, allowed: readonly T[], entries: string[]): Set<T> {
  const unknown = entries.filter((entry) => !(allowed as readonly string[]).includes(entry));
  if (unknown.length > 0) {
    throw new Error(
      `github.${key} has unknown value(s) ${unknown.join(", ")}; use ${allowed.join(", ")}`,
    );
  }
  return new Set(entries as T[]);
}

export function parseGithubPolicy(settings: GithubSettings | undefined): GithubPolicy {
  if (settings?.repos === undefined) {
    throw new Error(
      "GitHub is configured but has no repositories. Set github.repos in ~/.mikan/settings.json to owner/repo or owner/* entries.",
    );
  }
  const repos = normalizeList(settings.repos);
  if (repos.length === 0) {
    throw new Error("github.repos must list at least one owner/repo or owner/*");
  }
  const invalidRepos = repos.filter((entry) => !REPO_PATTERN.test(entry));
  if (invalidRepos.length > 0) {
    throw new Error(
      `github.repos has invalid entries ${invalidRepos.join(", ")}; use owner/repo or owner/*`,
    );
  }
  const minPermission = (settings.minPermission ?? "write").trim().toLowerCase();
  if (!(TRIGGER_PERMISSIONS as readonly string[]).includes(minPermission)) {
    throw new Error(`github.minPermission must be one of ${TRIGGER_PERMISSIONS.join(", ")}`);
  }
  const users = normalizeList(settings.users);
  return {
    repos,
    publicRepos: settings.publicRepos ?? false,
    users: users.length > 0 ? users : null,
    minPermission: minPermission as GithubTriggerPermission,
    triggers:
      settings.triggers === undefined
        ? new Set(GITHUB_TRIGGERS)
        : pickAll("triggers", GITHUB_TRIGGERS, normalizeList(settings.triggers)),
    capabilities: pickAll(
      "capabilities",
      GITHUB_CAPABILITIES,
      normalizeList(settings.capabilities),
    ),
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
