import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";

const SCRIPT = resolve("scripts/preflight-gondolin-fleet.sh");

describe("Gondolin fleet preflight", () => {
  let root = "";

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function prepare(machineId: "per-host" | "shared") {
    root = mkdtempSync(join(tmpdir(), "mikan-fleet-preflight-"));
    const bin = join(root, "bin");
    const workspace = join(root, "workspace");
    const workerEntry = join(root, "dist", "sandbox", "gondolin-worker-main.js");
    mkdirSync(bin, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    mkdirSync(join(root, "dist", "sandbox"), { recursive: true });
    writeFileSync(workerEntry, "");

    executable(
      join(bin, "ssh"),
      `#!/usr/bin/env bash\nset -euo pipefail\nwhile [ "$#" -gt 0 ] && [ "$1" = "-o" ]; do shift 2; done\nhost="$1"; shift\nMIKAN_FAKE_HOST="$host" bash -c "$1"\n`,
    );
    executable(join(bin, "uname"), "#!/usr/bin/env sh\nprintf 'Darwin\\n'\n");
    executable(
      join(bin, "sysctl"),
      `#!/usr/bin/env sh\ncase "$2" in\n  kern.boottime) printf 'sec = 123\\n' ;;\n  hw.uuid) ${machineId === "per-host" ? "printf '%s\\n' \"$MIKAN_FAKE_HOST\"" : "printf 'same-machine\\n'"} ;;\nesac\n`,
    );
    for (const command of ["qemu-system-aarch64", "mikan-worker", "nc"]) {
      executable(join(bin, command), "#!/usr/bin/env sh\nexit 0\n");
    }
    return {
      evidence: join(root, "evidence.log"),
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        MIKAN_GATEWAY_HOST: "gateway.test",
        MIKAN_WORKSPACE_ROOT: workspace,
        MIKAN_WORKER_WORKSPACE_ROOT: workspace,
        MIKAN_WORKER_ENTRY: workerEntry,
        MIKAN_PREFLIGHT_EVIDENCE: join(root, "evidence.log"),
      },
    };
  }

  test("records two explicitly named, distinct workers", () => {
    const fixture = prepare("per-host");

    execFileSync(SCRIPT, ["worker-a", "worker-b"], {
      env: fixture.env,
      stdio: "pipe",
    });

    const evidence = readFileSync(fixture.evidence, "utf8");
    expect(evidence).toContain("checking=worker-a");
    expect(evidence).toContain("checking=worker-b");
    expect(evidence).toContain("result=PASS workers=2 distinct_machine_ids=2");
  });

  test("rejects two SSH names that resolve to one machine identity", () => {
    const fixture = prepare("shared");

    expect(() =>
      execFileSync(SCRIPT, ["worker-a", "worker-b"], {
        env: fixture.env,
        stdio: "pipe",
      }),
    ).toThrow();

    expect(readFileSync(fixture.evidence, "utf8")).toContain(
      "SSH targets did not report distinct physical boot identities",
    );
  });
});

function executable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}
