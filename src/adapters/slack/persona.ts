/**
 * Spike: Slack display identity for the specialist that actually ran.
 *
 * Reskins only the Slack-visible `username`/`icon_emoji` on a reply — it does
 * not change the answering subagent's system prompt or tool grant, which stay
 * owned by `subagent-profiles.ts`. The lookup here is keyed by profile name so
 * the "who ran this" question has one answer, not two competing role models.
 */

export interface SlackPersonaIdentity {
  username: string;
  iconEmoji: string;
}

const PROFILE_IDENTITIES: Record<string, SlackPersonaIdentity> = {
  "data-scientist": { username: "Data Scientist", iconEmoji: ":bar_chart:" },
  "software-engineer": { username: "Software Engineer", iconEmoji: ":computer:" },
  "devops-engineer": { username: "DevOps Engineer", iconEmoji: ":gear:" },
  "account-manager": { username: "Account Manager", iconEmoji: ":handshake:" },
  "business-development": { username: "Business Development", iconEmoji: ":briefcase:" },
  "creative-producer": { username: "Creative Producer", iconEmoji: ":clapper:" },
  "ad-operations-specialist": { username: "Ad Operations Specialist", iconEmoji: ":loudspeaker:" },
};

/** Slack identity for a completed subagent's profile, or undefined for mikan's own identity. */
export function slackPersonaForProfile(profile: string): SlackPersonaIdentity | undefined {
  return PROFILE_IDENTITIES[profile];
}
