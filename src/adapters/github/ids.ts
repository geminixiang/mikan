import type { GithubConversationRef } from "./types.js";

/**
 * Conversation id for one issue/PR: `GH_<owner>_<repo>_<number>`.
 *
 * DESIGN.md originally proposed `gh:<owner>/<repo>#<number>`, but conversation
 * ids are used verbatim as a single path segment (LAYOUT.md § Casing) and the
 * conversation dir is bind-mounted with docker's `-v source:target` syntax in
 * image mode — so the id can contain neither `/` nor `:`. `_` is the
 * separator because it is the only inert character that also parses back
 * unambiguously under GitHub's name grammar: owners allow `-` (so `-` would
 * make the owner/repo boundary ambiguous) but never `_`, repos may contain
 * `_` but the trailing number is pure digits — so the first `_` and the last
 * `_` before the digits are always the real boundaries.
 *
 * Owner and repo are lowercased: GitHub names are case-insensitive (and this
 * id has two spelling sources — the GITHUB_REPOS env var and API payloads),
 * so per LAYOUT.md § Casing this is a mikan-derived slug, not a verbatim
 * platform id, and derived slugs are lowercased to keep one issue from
 * mapping to two conversation dirs on case-sensitive filesystems.
 */
export function buildGithubConversationId(ref: GithubConversationRef): string {
  return `GH_${ref.owner.toLowerCase()}_${ref.repo.toLowerCase()}_${ref.number}`;
}

const CONVERSATION_ID_PATTERN = /^GH_([A-Za-z0-9-]+)_(.+)_(\d+)$/;

export function parseGithubConversationId(conversationId: string): GithubConversationRef {
  // The greedy repo group splits at the last `_` followed by digits-to-end,
  // which is always the number boundary (repos may contain `_` themselves).
  const match = CONVERSATION_ID_PATTERN.exec(conversationId);
  if (!match) {
    throw new Error(`Not a GitHub conversation id: ${conversationId}`);
  }
  return {
    owner: match[1].toLowerCase(),
    repo: match[2].toLowerCase(),
    number: Number(match[3]),
  };
}

/** Message ts used for the issue/PR body itself (comments use their comment id). */
export const GITHUB_ISSUE_BODY_TS = "issue";
