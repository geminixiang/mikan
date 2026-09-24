import { describe, expect, test, vi } from "vitest";
import { DockerContainerManager } from "../sandbox/provisioner.js";

const KEY = "v1-slack-c123-k";
const NAME = `mikan-sandbox-${KEY}`;
const VOLUME = `mikan-home-${KEY}`;
const WORKSPACE_BIND = `/w/${KEY}:/workspace/${KEY}`;

function dockerMock(state: {
  status: "running" | "stopped" | "missing";
  homeVolume?: boolean;
  containerImage?: string;
  localImage?: string;
  binds?: string[];
  diff?: string[];
}) {
  const calls: string[][] = [];
  let status = state.status;
  const exec = vi.fn(async (_file: string, args: string[]) => {
    calls.push(args);
    const fmt = args[0] === "inspect" ? (args[2] ?? "") : "";
    if (args[0] === "rm") status = "missing";
    if (args[0] === "run" && args[1] === "-d") status = "running";
    if (args[0] === "image" && args[1] === "inspect") {
      if (!state.localImage) throw new Error("No such image");
      return { stdout: `${state.localImage}\n` };
    }
    if (args[0] === "inspect" && fmt.includes("State.Running")) {
      if (status === "missing") throw new Error("No such object");
      return {
        stdout: fmt.includes("\t")
          ? `${status === "running"}\t2026-09-24T00:00:00Z\t${KEY}\tC123\n`
          : `${status === "running"}\n`,
      };
    }
    if (args[0] === "inspect" && fmt.includes("HostConfig.Binds")) {
      const binds = state.binds ?? [];
      return {
        stdout: `${JSON.stringify(state.homeVolume ? [...binds, `${VOLUME}:/root`] : binds)}\n`,
      };
    }
    if (args[0] === "inspect" && fmt.includes("mount-signature")) return { stdout: "<no value>\n" };
    if (args[0] === "inspect" && fmt.includes("NetworkMode")) {
      return { stdout: `mikan-sandbox-net-${KEY}\n` };
    }
    if (args[0] === "inspect" && fmt === "{{.Image}}") {
      return { stdout: `${state.containerImage ?? "sha256:old"}\n` };
    }
    if (args[0] === "ps") return { stdout: `${NAME}\n` };
    if (args[0] === "diff") return { stdout: `${(state.diff ?? []).join("\n")}\n` };
    return { stdout: "ok\n" };
  });
  return { exec, calls };
}

function manager(exec: unknown): DockerContainerManager {
  return new DockerContainerManager("mikan-sandbox:latest", { execFileImpl: exec as any });
}

const MOUNTS: never[] = [];
const WORKSPACE_MOUNTS = [{ source: `/w/${KEY}`, target: `/workspace/${KEY}` }];

describe("DockerContainerManager home volume", () => {
  test("new containers mount a labeled per-office home volume at /root", async () => {
    const { exec, calls } = dockerMock({ status: "missing" });
    await manager(exec).provision(KEY, { mounts: MOUNTS, conversationId: "C123" });

    const create = calls.find((args) => args[0] === "volume" && args[1] === "create");
    expect(create).toContain(VOLUME);
    expect(create).toContain("mikan.managed=true");
    const run = calls.find((args) => args[0] === "run");
    expect(run).toContain(`${VOLUME}:/root`);
    expect(run).toContain("mikan-sandbox:latest");
  });

  test("a stopped home-volume container on a stale image is replaced, not committed", async () => {
    const { exec, calls } = dockerMock({
      status: "stopped",
      homeVolume: true,
      containerImage: "sha256:old",
      localImage: "sha256:new",
    });
    await manager(exec).provision(KEY, { mounts: MOUNTS, conversationId: "C123" });

    expect(calls.find((args) => args[0] === "commit")).toBeUndefined();
    expect(calls).toContainEqual(["rm", "-f", NAME]);
    const run = calls.find((args) => args[0] === "run");
    expect(run).toContain(`${VOLUME}:/root`);
    expect(run).toContain("mikan-sandbox:latest");
    expect(run).toContain("mikan.conversation-id=C123");
  });

  test("a running container on a stale image is left alone until it stops", async () => {
    const { exec, calls } = dockerMock({
      status: "running",
      homeVolume: true,
      containerImage: "sha256:old",
      localImage: "sha256:new",
    });
    await manager(exec).provision(KEY, { mounts: MOUNTS });

    expect(calls.find((args) => args[0] === "rm")).toBeUndefined();
    expect(calls.find((args) => args[0] === "run")).toBeUndefined();
  });

  test("a stopped container on the current image just starts", async () => {
    const { exec, calls } = dockerMock({
      status: "stopped",
      homeVolume: true,
      containerImage: "sha256:new",
      localImage: "sha256:new",
    });
    await manager(exec).provision(KEY, { mounts: MOUNTS });

    expect(calls).toContainEqual(["start", NAME]);
    expect(calls.find((args) => args[0] === "rm")).toBeUndefined();
  });

  test("an image missing locally never counts as drift (mikan never pulls)", async () => {
    const { exec, calls } = dockerMock({ status: "stopped", homeVolume: true });
    await manager(exec).provision(KEY, { mounts: MOUNTS });

    expect(calls).toContainEqual(["start", NAME]);
    expect(calls.find((args) => args[0] === "pull")).toBeUndefined();
  });

  test("the home volume bind is not mistaken for mount drift", async () => {
    const { exec, calls } = dockerMock({
      status: "running",
      homeVolume: true,
      localImage: "sha256:old",
    });
    await manager(exec).provision(KEY, { mounts: MOUNTS });

    expect(calls.find((args) => args[0] === "rm")).toBeUndefined();
  });

  test("mount drift on a home-volume container replaces it from the current image", async () => {
    const { exec, calls } = dockerMock({
      status: "running",
      homeVolume: true,
      binds: ["/w/old:/workspace/old"],
    });
    await manager(exec).provision(KEY, { mounts: WORKSPACE_MOUNTS });

    expect(calls.find((args) => args[0] === "commit")).toBeUndefined();
    const run = calls.find((args) => args[0] === "run");
    expect(run).toContain(WORKSPACE_BIND);
    expect(run).not.toContain("/w/old:/workspace/old");
  });

  test("remove keeps the home volume unless purged", async () => {
    const kept = dockerMock({ status: "stopped", homeVolume: true });
    await manager(kept.exec).remove(KEY);
    expect(kept.calls.find((args) => args[0] === "volume")).toBeUndefined();

    const purged = dockerMock({ status: "stopped", homeVolume: true });
    await manager(purged.exec).remove(KEY, { purgeHome: true });
    expect(purged.calls).toContainEqual(["volume", "rm", VOLUME]);
  });

  test("stop and provision on the same key run one after another", async () => {
    const order: string[] = [];
    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const base = dockerMock({ status: "running", homeVolume: true });
    const exec = vi.fn(async (file: string, args: string[]) => {
      if (args[0] === "stop") {
        order.push("stop:start");
        await stopGate;
        order.push("stop:end");
      }
      if (args[0] === "inspect" && args[2]?.includes("State.Running") && order.length > 0) {
        order.push("provision");
      }
      return base.exec(file, args);
    });
    const subject = manager(exec);
    const stopping = subject.stop(KEY);
    const provisioning = subject.provision(KEY, { mounts: MOUNTS });
    await Promise.resolve();
    releaseStop();
    await Promise.all([stopping, provisioning]);

    expect(order.slice(0, 3)).toEqual(["stop:start", "stop:end", "provision"]);
  });

  test("migrating a legacy container seeds the volume from its snapshot then runs the current image", async () => {
    const { exec, calls } = dockerMock({
      status: "stopped",
      homeVolume: false,
      binds: [WORKSPACE_BIND],
    });
    const outcome = await manager(exec).migrateToHomeVolume(KEY);

    expect(outcome).toBe("migrated");
    const verbs = calls.filter((args) => args[0] !== "inspect").map((args) => args.slice(0, 2));
    const commitAt = verbs.findIndex(([verb]) => verb === "commit");
    const seedAt = verbs.findIndex(([verb, flag]) => verb === "run" && flag === "--rm");
    const rmAt = verbs.findIndex(([verb]) => verb === "rm");
    const runAt = verbs.findIndex(([verb, flag]) => verb === "run" && flag === "-d");
    expect(commitAt).toBeGreaterThanOrEqual(0);
    expect(commitAt).toBeLessThan(seedAt);
    expect(seedAt).toBeLessThan(rmAt);
    expect(rmAt).toBeLessThan(runAt);
    const seed = calls.find((args) => args[0] === "run" && args[1] === "--rm");
    expect(seed).toContain(`${VOLUME}:/root`);
    expect(seed).toContain(`mikan-migrate:${NAME}`);
    const run = calls.find((args) => args[0] === "run" && args[1] === "-d");
    expect(run).toContain("mikan-sandbox:latest");
    expect(run).toContain(WORKSPACE_BIND);
    expect(run).toContain("mikan.conversation-id=C123");
    expect(calls).toContainEqual(["stop", NAME]);
    expect(calls).toContainEqual(["rmi", `mikan-migrate:${NAME}`]);
  });

  test("migration is a no-op for home-volume and missing containers", async () => {
    const done = dockerMock({ status: "running", homeVolume: true });
    expect(await manager(done.exec).migrateToHomeVolume(KEY)).toBe("already-migrated");
    expect(done.calls.find((args) => args[0] === "commit")).toBeUndefined();

    const gone = dockerMock({ status: "missing" });
    expect(await manager(gone.exec).migrateToHomeVolume(KEY)).toBe("missing");
  });

  test("inventory and system changes report what an upgrade affects", async () => {
    const { exec } = dockerMock({
      status: "stopped",
      homeVolume: false,
      localImage: "sha256:new",
      diff: ["C /root/.npm", "A /usr/bin/htop", "C /etc/apt", "A /workspace/x"],
    });
    const subject = manager(exec);

    expect(await subject.inventory()).toEqual([
      {
        containerName: NAME,
        containerKey: KEY,
        running: false,
        homeVolume: false,
        imageStale: true,
      },
    ]);
    expect(await subject.systemChanges(NAME)).toEqual(["A /usr/bin/htop", "C /etc/apt"]);
  });
});
