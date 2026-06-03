import { SessionManager } from "@earendil-works/pi-coding-agent";
export type { MikanSessionHeader } from "./types.js";
import type { MikanSessionHeader } from "./types.js";

export function isPlatformHistorySession(sessionFile: string): boolean {
  try {
    const header = SessionManager.open(sessionFile).getHeader() as MikanSessionHeader | null;
    return header?.source?.kind === "platform-history";
  } catch {
    return false;
  }
}
