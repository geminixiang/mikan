import { MikanSessionStorage } from "../harness/session-storage.js";
export type { MikanSessionHeader } from "./types.js";

export function isPlatformHistorySession(sessionFile: string): boolean {
  const header = MikanSessionStorage.peekHeader(sessionFile);
  return header?.source?.kind === "platform-history";
}
