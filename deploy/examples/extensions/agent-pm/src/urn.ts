/**
 * Subject URNs — the one module that mints and parses them.
 *
 * `Event.subject` and `Task.subject` name what a row is *about* as a string,
 * not a foreign key. A message about a company we have no row for still has
 * to land, so ingestion has no unroutable state; the URN gains meaning later
 * when the entity appears, with no backfill because it already points there.
 *
 * The cost is no referential integrity and no SQL join. Accepted: the
 * dominant query is a time-ordered scan by subject, which the
 * `(subject, occurred_at)` index serves exactly, and a URN outlives whatever
 * it names.
 */

/** Namespaces in use. Adding one means adding it here, nowhere else. */
export type UrnKind =
  | "member"
  | "team"
  | "task"
  | "board"
  | "customer"
  | "publisher"
  | "conversation"
  | "github"
  | "calendar"
  | "system";

export interface ParsedUrn {
  kind: UrnKind;
  /** Everything after the first colon, unparsed. */
  path: string;
}

const KNOWN: ReadonlySet<string> = new Set<UrnKind>([
  "member",
  "team",
  "task",
  "board",
  "customer",
  "publisher",
  "conversation",
  "github",
  "calendar",
  "system",
]);

/** `member:23` */
export function memberUrn(memberId: number): string {
  return `member:${memberId}`;
}

/** `team:devops` — slug, not id, so it survives a re-seed. */
export function teamUrn(slug: string): string {
  return `team:${slug}`;
}

/** `task:1042` */
export function taskUrn(taskId: number): string {
  return `task:${taskId}`;
}

/** `board:adops` */
export function boardUrn(slug: string): string {
  return `board:${slug}`;
}

/** `github:issue/acme/widgets/64` */
export function githubIssueUrn(owner: string, repo: string, number: number): string {
  return `github:issue/${owner}/${repo}/${number}`;
}

/** `github:pr/acme/widgets/121` */
export function githubPrUrn(owner: string, repo: string, number: number): string {
  return `github:pr/${owner}/${repo}/${number}`;
}

/** `customer:acme-media` */
export function customerUrn(slug: string): string {
  return `customer:${slug}`;
}

/** `publisher:example.com` */
export function publisherUrn(domain: string): string {
  return `publisher:${domain}`;
}

/** `conversation:slack/C0EXAMPLE1` */
export function conversationUrn(platform: string, conversationId: string): string {
  return `conversation:${platform}/${conversationId}`;
}

/** `calendar:event/abc123` */
export function calendarEventUrn(eventId: string): string {
  return `calendar:event/${eventId}`;
}

/** `system:sync/github`, `system:llm/agent-model` */
export function systemUrn(path: string): string {
  return `system:${path}`;
}

/** Split a URN into namespace and path; undefined for anything unrecognized. */
export function parseUrn(urn: string): ParsedUrn | undefined {
  const separator = urn.indexOf(":");
  if (separator <= 0 || separator === urn.length - 1) return undefined;
  const kind = urn.slice(0, separator);
  if (!KNOWN.has(kind)) return undefined;
  return { kind: kind as UrnKind, path: urn.slice(separator + 1) };
}

/** The member id in a `member:<id>` URN; undefined for any other shape. */
export function memberIdFromUrn(urn: string): number | undefined {
  const parsed = parseUrn(urn);
  if (parsed?.kind !== "member") return undefined;
  const id = Number(parsed.path);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

/** The task id in a `task:<id>` URN; undefined for any other shape. */
export function taskIdFromUrn(urn: string): number | undefined {
  const parsed = parseUrn(urn);
  if (parsed?.kind !== "task") return undefined;
  const id = Number(parsed.path);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

/** Parse `github:issue/<owner>/<repo>/<number>` back into its parts. */
export function parseGithubIssueUrn(
  urn: string,
): { owner: string; repo: string; number: number } | undefined {
  const parsed = parseUrn(urn);
  if (parsed?.kind !== "github") return undefined;
  const [type, owner, repo, rawNumber, ...rest] = parsed.path.split("/");
  if (type !== "issue" || !owner || !repo || !rawNumber || rest.length > 0) return undefined;
  const number = Number(rawNumber);
  return Number.isInteger(number) && number > 0 ? { owner, repo, number } : undefined;
}
