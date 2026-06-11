import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { posix } from "path";
import * as log from "../log.js";
import type { ContainerMount } from "../types.js";
import type { SandboxCapabilities, SandboxInstance } from "./spi.js";

/** Skip pushing credential files larger than this; they are not typical secrets. */
const MAX_PUSH_FILE_BYTES = 256 * 1024;

/**
 * Single audit chokepoint for secret injection. Logs key names and counts
 * only — never values — so operators can trace which scope received which
 * credentials through which mechanism.
 */
export function auditSecretInjection(details: {
  providerType: string;
  scopeKey: string;
  envKeys: readonly string[];
  envMode: SandboxCapabilities["envInjection"];
  pushedFiles?: number;
  mountedFiles?: number;
}): void {
  const parts: string[] = [];
  if (details.envKeys.length > 0) {
    parts.push(`env keys [${details.envKeys.join(", ")}] (${details.envMode})`);
  }
  if (details.pushedFiles) {
    parts.push(`${details.pushedFiles} pushed file(s)`);
  }
  if (details.mountedFiles) {
    parts.push(`${details.mountedFiles} mounted file(s)`);
  }
  if (parts.length === 0) return;

  log.logInfo(
    `vault: injecting ${parts.join(", ")} into ${details.providerType}:${details.scopeKey}`,
  );
}

/**
 * Project vault file credentials into a runtime through the instance fs API
 * (providers with capabilities.filePush). Returns the number of files pushed.
 */
export async function pushVaultFileMounts(
  instance: SandboxInstance,
  mounts: readonly ContainerMount[],
): Promise<number> {
  if (!instance.fs || mounts.length === 0) return 0;

  const files: { source: string; target: string }[] = [];
  for (const mount of mounts) {
    collectMountFiles(mount.source, mount.target, files);
  }

  const ensuredDirs = new Set<string>();
  let pushed = 0;
  for (const file of files) {
    const dir = posix.dirname(file.target);
    if (!ensuredDirs.has(dir)) {
      await instance.fs.mkdir(dir);
      ensuredDirs.add(dir);
    }
    await instance.fs.writeFile(file.target, readFileSync(file.source, "utf-8"));
    pushed++;
  }
  return pushed;
}

function collectMountFiles(
  source: string,
  target: string,
  out: { source: string; target: string }[],
): void {
  let stat;
  try {
    stat = statSync(source);
  } catch {
    return;
  }

  if (stat.isFile()) {
    if (stat.size > MAX_PUSH_FILE_BYTES) {
      log.logWarning(`vault: skipping oversized credential file for push`, source);
      return;
    }
    out.push({ source, target });
    return;
  }

  if (!stat.isDirectory()) return;
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    collectMountFiles(join(source, entry.name), posix.join(target, entry.name), out);
  }
}
