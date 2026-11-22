import type { OfficeDesktop } from "../sandbox/desktop.js";
import type { DockerContainerManager } from "../sandbox/provisioner.js";
import type { Workspace } from "../office/types.js";
import type { OpenDesktop } from "../types.js";
import type { VaultManager } from "../vault/types.js";
import { ActorExecutionResolver } from "./execution-resolver.js";

interface DesktopOpenerOptions {
  vaultManager: VaultManager;
  provisioner: DockerContainerManager;
  workspace: Workspace;
  desktop: Pick<OfficeDesktop, "start">;
}

export function createDesktopOpener(options: DesktopOpenerOptions): OpenDesktop {
  const resolver = new ActorExecutionResolver(
    options.vaultManager,
    options.provisioner,
    options.workspace,
  );
  return async (actor) => options.desktop.start(await resolver.prepare(actor));
}
