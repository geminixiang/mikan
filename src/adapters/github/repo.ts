import { execFile } from "node:child_process";
import { join } from "node:path";
import type { Office } from "../../office/types.js";
import { promisify } from "node:util";
import type {
  CloneRepoOptions,
  PushBranchOptions,
  SyncRepoOptions,
  SyncRepoResult,
} from "./types.js";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 120_000;

export const GITHUB_PUSH_BRANCH_PATTERN = /^pi\/[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

export function conversationRepoDir(office: Office): string {
  return join(office.dir, "repo");
}

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

function isSafeBranchName(name: string): boolean {
  return (
    name.length > 0 && !name.startsWith("-") && !name.includes("..") && !/[\s~^:?*[\\]/.test(name)
  );
}

function prCheckoutName(prNumber: number, prHeadBranch?: string): string {
  return prHeadBranch && isSafeBranchName(prHeadBranch) ? prHeadBranch : `pr-${prNumber}`;
}

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
  const legacyPrBranch = options.prNumber !== undefined ? `pr-${options.prNumber}` : undefined;
  const onTarget =
    currentBranch === target || (legacyPrBranch !== undefined && currentBranch === legacyPrBranch);
  let localCommits = 0;
  if (onTarget) {
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
