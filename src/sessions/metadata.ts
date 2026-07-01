import { SessionStore } from "../harness/index.js";
export type { MikanSessionHeader } from "./types.js";
import type { MikanSessionHeader } from "./types.js";

export function isPlatformHistorySession(sessionFile: string): boolean {
  try {
    const header = SessionStore.open(sessionFile).getHeader() as MikanSessionHeader | null;
    return header?.source?.kind === "platform-history";
  } catch {
    return false;
  }
}
