import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import * as publicApi from "../index.js";

const EXPECTED_RUNTIME_EXPORTS = [
  "MikanModels",
  "createConversationEvent",
  "createConversationMessage",
  "createConversationRuntime",
  "createOfficeAddress",
  "createWorkspace",
  "defaultCommandHandlers",
  "officeKey",
].toSorted();

describe("public package interface", () => {
  test("changes only through an intentional snapshot update", () => {
    expect(Object.keys(publicApi).toSorted()).toEqual(EXPECTED_RUNTIME_EXPORTS);
  });

  test("snapshots the TypeScript declaration surface", () => {
    const declarations = readFileSync("dist/index.d.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("export "))
      .join("\n");
    expect(declarations).toMatchSnapshot();
  });

  test("declares only the root entry point", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      exports?: Record<string, unknown>;
    };
    expect(Object.keys(packageJson.exports ?? {}).toSorted()).toEqual([".", "./package.json"]);
  });
});
