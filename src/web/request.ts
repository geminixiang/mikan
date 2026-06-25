import type { IncomingMessage } from "http";
import { resolveLinkBaseUrl } from "../config.js";

export function requestBaseUrl(req: IncomingMessage): string {
  const configured = resolveLinkBaseUrl();
  if (configured) return configured;

  const protoRaw = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim();
  const proto = protoRaw || "http";
  const host =
    (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim() ||
    req.headers.host ||
    "localhost";
  return `${proto}://${host}`;
}
