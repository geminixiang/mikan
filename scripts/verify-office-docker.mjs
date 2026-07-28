#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const image = process.env.MIKAN_OFFICE_TEST_IMAGE ?? "alpine:3.21";
const testRoot = join(process.cwd(), ".workspace");
mkdirSync(testRoot, { recursive: true });
const root = mkdtempSync(join(testRoot, "mikan-office-docker-"));
const officeA = join(root, "office-a");
const officeB = join(root, "office-b");
const outside = join(root, "outside-secret.txt");

function docker(args) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function runOffice(command) {
  return docker([
    "run",
    "--rm",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--mount",
    `type=bind,src=${officeA},dst=/workspace/office-a`,
    image,
    "sh",
    "-eu",
    "-c",
    command,
  ]).trim();
}

try {
  docker(["version", "--format", "{{.Server.Version}}"]).trim();
  docker(["image", "inspect", image]);

  mkdirSync(officeA, { recursive: true });
  mkdirSync(officeB, { recursive: true });
  writeFileSync(join(officeA, "own.txt"), "office-a");
  writeFileSync(join(officeB, "secret.txt"), "office-b-secret");
  writeFileSync(outside, "host-secret");

  assert.equal(runOffice('test "$(cat /workspace/office-a/own.txt)" = office-a; echo ok'), "ok");
  assert.equal(
    runOffice(
      "test ! -e /workspace/office-b && test ! -e /workspace/MEMORY.md && test ! -e /workspace/events; echo isolated",
    ),
    "isolated",
  );

  runOffice("printf persisted > /workspace/office-a/runtime-state.txt");
  assert.equal(readFileSync(join(officeA, "runtime-state.txt"), "utf8"), "persisted");
  assert.equal(runOffice("cat /workspace/office-a/runtime-state.txt"), "persisted");

  symlinkSync(outside, join(officeA, "absolute-leak"));
  assert.throws(
    () => runOffice("cat /workspace/office-a/absolute-leak"),
    /No such file|can't open|not found/i,
  );
  assert.equal(readFileSync(outside, "utf8"), "host-secret");

  const relativeLeak = join(officeA, "relative-leak");
  symlinkSync("../office-b/secret.txt", relativeLeak);
  assert.throws(
    () => runOffice("cat /workspace/office-a/relative-leak"),
    /No such file|can't open|not found/i,
  );

  assert.equal(lstatSync(relativeLeak).isSymbolicLink(), true);

  const network = runOffice(
    "if command -v wget >/dev/null 2>&1; then wget -q -T 10 -O /dev/null https://example.com; fi; echo outbound",
  );
  assert.equal(network, "outbound");

  console.log("PASS: isolated office cannot see sibling/shared roots");
  console.log("PASS: office writes persist across disposable container runs");
  console.log("PASS: absolute and sibling-relative symlinks do not reveal unmounted host data");
  console.log("PASS: outbound network remains available");
} finally {
  rmSync(root, { recursive: true, force: true });
}
