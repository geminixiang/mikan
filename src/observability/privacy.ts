import { createHash, createHmac } from "node:crypto";
import { readStandardEnv } from "../env-manifest.js";

const IDENTIFIER_LENGTH = 16;

/** Return a stable opaque identifier suitable for third-party telemetry. */
export function telemetryIdentifier(namespace: string, value: string): string {
  const key = readStandardEnv("TELEMETRY_HASH_KEY");
  const digest = key
    ? createHmac("sha256", key).update(`${namespace}\0${value}`).digest("hex")
    : createHash("sha256").update(`${namespace}\0${value}`).digest("hex");
  return `${namespace}_${digest.slice(0, IDENTIFIER_LENGTH)}`;
}
