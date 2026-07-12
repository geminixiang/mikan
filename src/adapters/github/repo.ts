import { execFile } from "child_process";
import { promisify } from "util";
import type { CloneRepoOptions, PushBranchOptions } from "./types.js";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 120_000;

/**
 * Branches the bot may push: `pi/<name>`. Everything else — including the
 * repo's default branch by construction — is refused, so a driven agent can
 * only ever produce reviewable branches, never touch mainline directly.
 */
export const GITHUB_PUSH_BRANCH_PATTERN = /^pi\/[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

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
 * Shallow-clone a repo into a conversation dir and preconfigure the bot's
 * commit identity. For PR conversations, additionally fetch the PR head and
 * check it out as `pr-<number>` so the agent starts on the code under review.
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
    await git(["-C", options.dir, "checkout", "-B", `pr-${options.prNumber}`, "FETCH_HEAD"]);
  }
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
