import type { GithubConversationRef } from "./types.js";

export function buildGithubConversationId(ref: GithubConversationRef): string {
  return `GH_${ref.owner.toLowerCase()}_${ref.repo.toLowerCase()}_${ref.number}`;
}

const CONVERSATION_ID_PATTERN = /^GH_([A-Za-z0-9-]+)_(.+)_(\d+)$/;

export function parseGithubConversationId(conversationId: string): GithubConversationRef {
  const match = CONVERSATION_ID_PATTERN.exec(conversationId);
  if (!match) {
    throw new Error(`Not a GitHub conversation id: ${conversationId}`);
  }
  const [, owner, repo, number] = match;
  if (owner === undefined || repo === undefined || number === undefined) {
    throw new Error(`Not a GitHub conversation id: ${conversationId}`);
  }
  return {
    owner: owner.toLowerCase(),
    repo: repo.toLowerCase(),
    number: Number(number),
  };
}

export const GITHUB_ISSUE_BODY_TS = "issue";

export function githubReviewCommentTs(commentId: number): string {
  return `rc-${commentId}`;
}

export function parseReviewCommentTs(ts: string): number | null {
  const match = /^rc-(\d+)$/.exec(ts);
  return match ? Number(match[1]) : null;
}
