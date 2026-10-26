import type { PortalShellOptions } from "../../types.js";

export interface TokenRecord {
  token: string;
  expiresAt: number;
}

export interface StatusPageOptions extends Omit<PortalShellOptions, "body"> {
  eyebrow: string;
  title: string;
  message: string;
  tone: "ok" | "err";
  closeNote?: boolean;
}
