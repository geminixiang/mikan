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

export function slackPersonaForProfile(profile: string): SlackPersonaIdentity | undefined {
  return PROFILE_IDENTITIES[profile];
}
