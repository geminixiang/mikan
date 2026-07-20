import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { acquireGondolinCoordinatorLock } from "../src/sandbox/gondolin-coordinator-lock.js";

describe("Gondolin coordinator lock", () => {
  let dir = "";

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("excludes another coordinator and releases cleanly", () => {
    dir = mkdtempSync(join(tmpdir(), "gondolin-coordinator-"));
    const release = acquireGondolinCoordinatorLock(dir);

    expect(() => acquireGondolinCoordinatorLock(dir)).toThrow(
      "already owned by coordinator process",
    );

    release();
    const releaseAgain = acquireGondolinCoordinatorLock(dir);
    releaseAgain();
  });

  test("recovers a dead local owner", () => {
    dir = mkdtempSync(join(tmpdir(), "gondolin-coordinator-"));
    const firstRelease = acquireGondolinCoordinatorLock(dir);
    const currentOwner = JSON.parse(
      readFileSync(join(dir, "gondolin-coordinator.lock", "owner.json"), "utf8"),
    );
    firstRelease();
    const lockDir = join(dir, "gondolin-coordinator.lock");
    mkdirSync(lockDir);
    writeFileSync(
      join(lockDir, "owner.json"),
      JSON.stringify({ ...currentOwner, pid: 2_147_483_647, nonce: "stale" }),
    );

    const release = acquireGondolinCoordinatorLock(dir);
    release();
  });

  test("never breaks a lock owned by another machine", () => {
    dir = mkdtempSync(join(tmpdir(), "gondolin-coordinator-"));
    const lockDir = join(dir, "gondolin-coordinator.lock");
    mkdirSync(lockDir);
    writeFileSync(
      join(lockDir, "owner.json"),
      JSON.stringify({
        pid: 2_147_483_647,
        machine: "another-machine",
        nonce: "remote",
        startedAt: new Date().toISOString(),
      }),
    );

    expect(() => acquireGondolinCoordinatorLock(dir)).toThrow(
      "cross-host lock recovery requires operator intervention",
    );
  });

  test("fails closed for an unreadable owner record", () => {
    dir = mkdtempSync(join(tmpdir(), "gondolin-coordinator-"));
    const lockDir = join(dir, "gondolin-coordinator.lock");
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, "owner.json"), "not-json");

    expect(() => acquireGondolinCoordinatorLock(dir)).toThrow(
      "refusing to reset placement authority",
    );
  });
});
