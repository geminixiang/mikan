import { SessionManager } from "@earendil-works/pi-coding-agent";

export interface MamaSessionHeader {
  type?: string;
  version?: number;
  id?: string;
  timestamp?: string;
  cwd?: string;
  parentSession?: string;
  source?: {
    kind?: string;
    file?: string;
    recentDays?: number;
  };
}

export function isPlatformHistorySession(sessionFile: string): boolean {
  try {
    const header = SessionManager.open(sessionFile).getHeader() as MamaSessionHeader | null;
    return header?.source?.kind === "platform-history";
  } catch {
    return false;
  }
}
