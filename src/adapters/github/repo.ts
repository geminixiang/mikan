import { execFile } from "child_process";
import { join } from "path";
import { conversationOfficeDir, createOfficeAddress } from "../../office-address.js";
import { promisify } from "util";
import type {
  CloneRepoOptions,
  PushBranchOptions,
  SyncRepoOptions,
  SyncRepoResult,
} from "./types.js";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 120_000;

/**
 * Branches the bot may push: `pi/<name>`. Everything else — including the
 * repo's default branch by construction — is refused, so a driven agent can
 * only ever produce reviewable branches, never touch mainline directly.
 */
export const GITHUB_PUSH_BRANCH_PATTERN = /^pi\/[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

/** The conversation's clone location (bind-mounted into the sandbox as ./repo). */
export function conversationRepoDir(workingDir: string, conversationId: string): string {
  return join(
    conversationOfficeDir(workingDir, createOfficeAddress("github", conversationId)),
    "repo",
  );
}

/**
 * Pass the ephemeral token as a per-invocation header, never in the remote
 * URL: nothing credential-shaped may end up in `.git/config`, which lives in
 * the conversation dir and is bind-mounted into the sandbox.
 */
function gitAuthArgs(token: string): string[] {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return ["-c", `http.extraheader=Authorization: basic ${basic}`];
}

async function git(args: string[], token?: string): Promise<string> {
  const { stdout } = await execFileAsync("git", [...(token ? gitAuthArgs(token) : []), ...args], {
    timeout: GIT_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout;
}

/**
 * Git itself rejects these ref shapes; the check just keeps an API-supplied
 * branch name that would parse as a git option (leading dash) or an invalid
 * ref out of argv entirely instead of surfacing as a git error mid-clone.
 */
function isSafeBranchName(name: string): boolean {
  return (
    name.length > 0 && !name.startsWith("-") && !name.includes("..") && !/[\s~^:?*[\\]/.test(name)
  );
}

/**
 * Local checkout name for a PR conversation: the PR's real head branch when
 * known (same-repo heads only — the caller resolves that), falling back to
 * the synthetic `pr-<n>` for fork PRs, unresolvable heads, and unsafe names.
 * Using the real name is what lets the agent update the PR in place: commit
 * on a `pi/*` head and `github_pr` pushes back to the same branch.
 */
function prCheckoutName(prNumber: number, prHeadBranch?: string): string {
  return prHeadBranch && isSafeBranchName(prHeadBranch) ? prHeadBranch : `pr-${prNumber}`;
}

/**
 * Shallow-clone a repo into a conversation dir and preconfigure the bot's
 * commit identity. For PR conversations, additionally fetch the PR head and
 * check it out so the agent starts on the code under review — under its real
 * branch name when the caller resolved one, which is what lets the agent push
 * fixes back to the PR itself.
 */
export async function cloneRepo(options: CloneRepoOptions): Promise<void> {
  await git(["clone", "--depth", "50", options.url, options.dir], options.token);
  await git(["-C", options.dir, "config", "user.name", options.botLogin]);
  await git(["-C", options.dir, "config", "user.email", options.botEmail]);
  if (options.prNumber !== undefined) {
    await git(
      ["-C", options.dir, "fetch", "--depth", "50", "origin", `pull/${options.prNumber}/head`],
      options.token,
    );
    await git([
      "-C",
      options.dir,
      "checkout",
      "-B",
      prCheckoutName(options.prNumber, options.prHeadBranch),
      "FETCH_HEAD",
    ]);
  }
}

/**
 * Refresh a conversation clone from origin. Always fetches; only moves the
 * checkout when that provably cannot lose agent work: the target branch is
 * the one checked out, the tree is clean, and it has no commits of its own
 * (`checkout -B` then handles fast-forward and force-pushed heads alike).
 * Anything else stays fetch-only — FETCH_HEAD is left for the agent, which
 * has full credential-less git inside the sandbox, to merge or rebase itself.
 */
export async function syncRepo(options: SyncRepoOptions): Promise<SyncRepoResult> {
  const { dir, token } = options;
  let refspec: string;
  let target: string;
  if (options.branch) {
    refspec = options.branch;
    target = options.branch;
  } else if (options.prNumber !== undefined) {
    refspec = `pull/${options.prNumber}/head`;
    target = prCheckoutName(options.prNumber, options.prHeadBranch);
  } else if (options.defaultBranch) {
    refspec = options.defaultBranch;
    target = options.defaultBranch;
  } else {
    throw new Error("syncRepo needs a branch, a PR number, or the default branch");
  }

  await git(["-C", dir, "fetch", "--depth", "50", "origin", refspec], token);
  const fetchedSha = (await git(["-C", dir, "rev-parse", "FETCH_HEAD"])).trim();
  const dirty = (await git(["-C", dir, "status", "--porcelain"])).trim().length > 0;
  const currentBranch = (await git(["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"])).trim();
  // Clones made before the head branch name was resolvable sit on the
  // synthetic pr-<n>; treat that as the same checkout so a clean sync
  // migrates them to the real name instead of going fetch-only forever.
  const legacyPrBranch = options.prNumber !== undefined ? `pr-${options.prNumber}` : undefined;
  const onTarget =
    currentBranch === target || (legacyPrBranch !== undefined && currentBranch === legacyPrBranch);
  let localCommits = 0;
  if (onTarget) {
    // Commits unique to HEAD split two ways: ones the agent committed here
    // (the clone's preconfigured bot identity) are its work and must survive;
    // ones committed by others were force-pushed away upstream and are safe
    // to drop. Filter by the bot committer so a rebased PR head still syncs.
    const botEmail = (await git(["-C", dir, "config", "user.email"])).trim();
    localCommits = Number(
      (
        await git(["-C", dir, "rev-list", "--count", `--committer=${botEmail}`, "FETCH_HEAD..HEAD"])
      ).trim(),
    );
  }

  const updatedCheckout = onTarget && !dirty && localCommits === 0;
  if (updatedCheckout) {
    await git(["-C", dir, "checkout", "-B", target, "FETCH_HEAD"]);
  }
  return { target, fetchedSha, updatedCheckout, dirty, currentBranch, localCommits };
}

/**
 * Push one local branch to origin. Non-force by construction (plain refspec),
 * and only `pi/*` branches are accepted.
 */
export async function pushBranch(options: PushBranchOptions): Promise<void> {
  const { dir, branch, token } = options;
  if (!GITHUB_PUSH_BRANCH_PATTERN.test(branch)) {
    throw new Error(
      `Refusing to push branch '${branch}': only branches matching pi/<name> may be pushed.`,
    );
  }
  try {
    await git(["-C", dir, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  } catch {
    throw new Error(`Branch '${branch}' does not exist in the conversation's ./repo clone.`);
  }
  await git(["-C", dir, "push", "origin", `refs/heads/${branch}:refs/heads/${branch}`], token);
}
