import { execFileSync } from "node:child_process";
import { platform } from "node:os";
import * as log from "../log.js";

interface NfsAdvisoryDeps {
  os?: NodeJS.Platform;
  run?: (cmd: string, args: string[]) => string;
  emit?: (line: string) => void;
}

/**
 * Startup advisory for gondolin:remote workers: they need the mikan-host
 * workspace on shared storage, and the simplest way is to NFS-export it from
 * the host itself. mikan does NOT touch root or system files — it only checks
 * whether the workspace is already exported and, if not, prints the
 * OS-appropriate commands the operator runs once by hand.
 */
export function checkWorkspaceExported(
  workspaceDir: string,
  gatewayHostname?: string,
  deps: NfsAdvisoryDeps = {},
): void {
  const os = deps.os ?? platform();
  const emit = deps.emit ?? ((line: string) => console.log(line));
  if (os !== "darwin" && os !== "linux") {
    log.logWarning(
      `gondolin:remote workers need ${workspaceDir} on shared storage; NFS auto-detection is unavailable on ${os}`,
    );
    return;
  }
  if (isExported(os, workspaceDir, deps.run)) {
    log.logInfo(`Workspace ${workspaceDir} is NFS-exported for remote workers`);
    return;
  }
  for (const line of setupLines(os, workspaceDir, gatewayHostname)) emit(line);
}

function isExported(
  os: NodeJS.Platform,
  workspaceDir: string,
  run: NfsAdvisoryDeps["run"],
): boolean {
  const exec =
    run ?? ((cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: "utf8" }));
  try {
    if (os === "darwin") {
      const out = exec("showmount", ["-e", "localhost"]);
      return out.split("\n").some((line) => line.trimStart().startsWith(workspaceDir));
    }
    // linux: exportfs -s lists current exports
    const out = exec("exportfs", ["-s"]);
    return out
      .split("\n")
      .some((line) => line.startsWith(workspaceDir + " ") || line === workspaceDir);
  } catch {
    // no NFS server running / tool missing → treat as not exported
    return false;
  }
}

function setupLines(os: NodeJS.Platform, workspaceDir: string, gatewayHostname?: string): string[] {
  const hostHint = gatewayHostname ?? "<host-tailscale-ip>";
  const lines: string[] = [
    "",
    "  ⚠ gondolin:remote workers need this workspace on shared storage.",
    `    Export it from this host once (mikan will not modify system files):`,
    "",
  ];
  if (os === "darwin") {
    lines.push(
      `    echo '${workspaceDir} -network 100.64.0.0 -mask 255.192.0.0 -mapall=$(id -u):$(id -g)' | sudo tee -a /etc/exports`,
      `    sudo nfsd enable && sudo nfsd start`,
    );
  } else {
    lines.push(
      `    echo '${workspaceDir} 100.64.0.0/10(rw,sync,no_subtree_check,all_squash,anonuid=$(id -u),anongid=$(id -g))' | sudo tee -a /etc/exports`,
      `    sudo exportfs -ra && sudo systemctl enable --now nfs-server`,
    );
  }
  lines.push(
    "",
    "    Then on each worker (over tailscale), mount it and point --workspace-root at it:",
    `    sudo mount -t nfs -o vers=3,resvport,nolock ${hostHint}:${workspaceDir} /mnt/mikan-workspace`,
    "",
    "    100.64.0.0/10 is the tailscale range; -mapall/all_squash makes worker",
    "    writes owned by you on the host. Skip this only if you already share the",
    "    workspace another way (existing NFS, GCS-fuse, etc.).",
    "",
  );
  return lines;
}
