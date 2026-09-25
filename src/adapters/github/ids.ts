export const GITHUB_ISSUE_BODY_TS = "issue";

export function githubReviewCommentTs(commentId: number): string {
  return `rc-${commentId}`;
}

export function parseReviewCommentTs(ts: string): number | null {
  const match = /^rc-(\d+)$/.exec(ts);
  return match ? Number(match[1]) : null;
}
