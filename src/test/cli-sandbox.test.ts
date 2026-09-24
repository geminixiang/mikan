import { describe, expect, test, vi } from "vitest";
import { resolveBoot } from "../cli/boot.js";
import { runSandboxCommand } from "../cli/sandbox.js";
import type { DockerContainerManager } from "../sandbox/provisioner.js";

function fakeManager(overrides: Partial<DockerContainerManager>): DockerContainerManager {
  return overrides as DockerContainerManager;
}

describe("mikan sandbox", () => {
  test("routes the sandbox subcommand", () => {
    const plan = resolveBoot(["sandbox", "status", "--image", "img"]);
    expect(plan.mode).toBe("sandbox");
    expect(plan.sandboxArgs).toEqual(["status", "--image", "img"]);
  });

  test("status reports legacy and stale containers against the given image", async () => {
    const images: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await runSandboxCommand(["status", "--image", "mikan-sandbox:2"], (image) => {
      images.push(image);
      return fakeManager({
        inventory: async () => [
          {
            containerName: "n1",
            containerKey: "k1",
            running: true,
            homeVolume: false,
            imageStale: true,
          },
          {
            containerName: "n2",
            containerKey: "k2",
            running: false,
            homeVolume: true,
            imageStale: true,
          },
        ],
      });
    });
    const output = log.mock.calls.map((call) => String(call[0]));
    log.mockRestore();

    expect(code).toBe(0);
    expect(images).toEqual(["mikan-sandbox:2"]);
    expect(output).toContain("k1\trunning\tlegacy\tstale-image");
    expect(output.at(-1)).toContain("1 legacy");
    expect(output.at(-1)).toContain("1 home-volume on a stale image");
  });

  test("migrate fails when any container is missing or errors", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await runSandboxCommand(["migrate", "a", "b", "c", "--image", "img"], () =>
      fakeManager({
        migrateToHomeVolume: async (key: string) => {
          if (key === "c") throw new Error("boom");
          return key === "a" ? "migrated" : "missing";
        },
      }),
    );
    const lines = log.mock.calls.map((call) => String(call[0]));
    log.mockRestore();
    error.mockRestore();

    expect(code).toBe(1);
    expect(lines).toEqual(["a\tmigrated", "b\tmissing"]);
  });

  test("requires --image", async () => {
    const error = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = await runSandboxCommand(["status"], () => fakeManager({}));
    error.mockRestore();
    expect(code).not.toBe(0);
  });
});
