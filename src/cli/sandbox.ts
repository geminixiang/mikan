import { DockerContainerManager } from "../sandbox/provisioner.js";
import { cliCommand, commandExitCode, nonEmptyValue } from "./arg-grammar.js";
import { errorMessage } from "../unknown-values.js";

interface SandboxCommandOptions {
  image?: string;
}

export async function runSandboxCommand(
  argv: string[],
  createManager: (image: string) => DockerContainerManager = (image) =>
    new DockerContainerManager(image),
): Promise<number> {
  const command = cliCommand("mikan sandbox")
    .description("Inspect and upgrade managed image:* sandbox containers")
    .requiredOption(
      "--image <image>",
      "The image the daemon runs with (image:<image>)",
      nonEmptyValue,
    );
  let result = 1;
  const manager = (): DockerContainerManager =>
    createManager(command.opts<SandboxCommandOptions>().image ?? "");
  command
    .command("status")
    .description("List managed containers with home-volume and image-drift state")
    .action(async () => {
      result = await printStatus(manager());
    });
  command
    .command("diff <containerKey>")
    .description("Show system changes outside /root that an upgrade will discard")
    .action(async (containerKey: string) => {
      result = await printSystemChanges(manager(), containerKey);
    });
  command
    .command("migrate <containerKeys...>")
    .description("Move legacy containers onto a home volume and the current image")
    .action(async (containerKeys: string[]) => {
      result = await migrateContainers(manager(), containerKeys);
    });
  try {
    await command.parseAsync(argv, { from: "user" });
    return result;
  } catch (error) {
    return commandExitCode(error, command);
  }
}

async function printStatus(manager: DockerContainerManager): Promise<number> {
  const entries = await manager.inventory();
  if (entries.length === 0) {
    console.log("No managed sandbox containers.");
    return 0;
  }
  for (const entry of entries) {
    const state = entry.running ? "running" : "stopped";
    const layout = entry.homeVolume ? "home-volume" : "legacy";
    const image = entry.imageStale ? "stale-image" : "current-image";
    console.log(`${entry.containerKey ?? entry.containerName}\t${state}\t${layout}\t${image}`);
  }
  const legacy = entries.filter((entry) => !entry.homeVolume).length;
  const stale = entries.filter((entry) => entry.homeVolume && entry.imageStale).length;
  console.log(
    `${entries.length} container(s): ${legacy} legacy (run \`mikan sandbox migrate\`), ${stale} home-volume on a stale image (replaced on next start after idle stop).`,
  );
  return 0;
}

async function printSystemChanges(
  manager: DockerContainerManager,
  containerKey: string,
): Promise<number> {
  const changes = await manager.systemChanges(DockerContainerManager.containerName(containerKey));
  if (changes.length === 0) {
    console.log("No system changes outside /root and /workspace.");
    return 0;
  }
  for (const line of changes) console.log(line);
  console.log(`${changes.length} path(s) outside /root will be discarded by an upgrade.`);
  return 0;
}

async function migrateContainers(
  manager: DockerContainerManager,
  containerKeys: readonly string[],
): Promise<number> {
  let failed = 0;
  for (const containerKey of containerKeys) {
    try {
      const outcome = await manager.migrateToHomeVolume(containerKey);
      console.log(`${containerKey}\t${outcome}`);
      if (outcome === "missing") failed++;
    } catch (error) {
      failed++;
      console.error(`${containerKey}\tfailed\t${errorMessage(error)}`);
    }
  }
  return failed === 0 ? 0 : 1;
}
