import { expect, test } from "vitest";
import { readRepositoryFile } from "./source-scan.js";

const exactVersion = /^\d+\.\d+\.\d+(-[\w.]+)?$/;

test("Pi packages are pinned to exact versions, because Pi ships breaking changes in minor releases and a range lets a clean install resolve past the version the lockfile tests", () => {
  const manifest = JSON.parse(readRepositoryFile("package.json")) as {
    dependencies: Record<string, string>;
  };
  const piPackages = Object.entries(manifest.dependencies).filter(([name]) =>
    name.startsWith("@earendil-works/"),
  );

  expect(piPackages.length).toBeGreaterThan(0);
  expect(piPackages.filter(([, version]) => !exactVersion.test(version))).toEqual([]);
  expect(new Set(piPackages.map(([, version]) => version)).size).toBe(1);
});
