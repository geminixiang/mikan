import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

interface JscpdClone {
  firstFile: { name: string; start: number; end: number };
  secondFile: { name: string; start: number; end: number };
  lines: number;
}

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const duplicationScript = "duplication";
const scannedRoot = "src";

const productionCloneBudget: Record<string, number> = {
  "src/adapters/discord/context.ts <-> src/adapters/github/context.ts": 1,
  "src/sandbox/cloudflare.ts <-> src/sandbox/container.ts": 1,
};

function detectProductionClones(): JscpdClone[] {
  const outputDirectory = mkdtempSync(join(tmpdir(), "mikan-jscpd-"));
  try {
    execFileSync(
      "npm",
      [
        "run",
        "--silent",
        duplicationScript,
        "--",
        "--reporters",
        "json",
        "--output",
        outputDirectory,
        "--silent",
      ],
      { cwd: repositoryRoot, stdio: "pipe" },
    );
    const report = JSON.parse(readFileSync(join(outputDirectory, "jscpd-report.json"), "utf8")) as {
      duplicates: JscpdClone[];
    };
    return report.duplicates;
  } catch (error) {
    throw new Error(`npm run ${duplicationScript} failed`, { cause: error });
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
}

function repositoryPath(name: string): string {
  return `${scannedRoot}/${name}`;
}

function pairKey(clone: JscpdClone): string {
  return [repositoryPath(clone.firstFile.name), repositoryPath(clone.secondFile.name)]
    .toSorted()
    .join(" <-> ");
}

function describeClone(clone: JscpdClone): string {
  const first = `${repositoryPath(clone.firstFile.name)}:${clone.firstFile.start}-${clone.firstFile.end}`;
  const second = `${repositoryPath(clone.secondFile.name)}:${clone.secondFile.start}-${clone.secondFile.end}`;
  return `${first} duplicates ${second} (${clone.lines} lines)`;
}

describe("production duplication ratchet", () => {
  test("clone pairs match the budget exactly", () => {
    const clones = detectProductionClones();
    const counts: Record<string, number> = {};
    for (const clone of clones) counts[pairKey(clone)] = (counts[pairKey(clone)] ?? 0) + 1;

    const overBudget = clones.filter(
      (clone) => (counts[pairKey(clone)] ?? 0) > (productionCloneBudget[pairKey(clone)] ?? 0),
    );
    expect(
      overBudget.map(describeClone),
      "New duplicated code: move the shared logic to one owning module and call it from both sites instead of raising productionCloneBudget.",
    ).toEqual([]);
    expect(
      counts,
      "Duplication was removed: lower productionCloneBudget to these counts in the same change.",
    ).toEqual(productionCloneBudget);
  }, 60_000);
});
