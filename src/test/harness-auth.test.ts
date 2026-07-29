import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { FileCredentialStore } from "../harness/index.js";

let dir: string;
let authPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mikan-harness-auth-"));
  authPath = join(dir, "auth.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("FileCredentialStore", () => {
  test("reads credentials from an existing auth.json", async () => {
    writeFileSync(authPath, JSON.stringify({ anthropic: { type: "api_key", key: "sk-test" } }));
    const store = new FileCredentialStore(authPath);
    expect(await store.read("anthropic")).toEqual({ type: "api_key", key: "sk-test" });
    expect(await store.read("missing")).toBeUndefined();
  });

  test("modify persists atomically with private permissions", async () => {
    const store = new FileCredentialStore(authPath);
    await store.modify("openai", async () => ({ type: "api_key", key: "sk-new" }));

    const written = JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, unknown>;
    expect(written.openai).toEqual({ type: "api_key", key: "sk-new" });
    expect(statSync(authPath).mode & 0o777).toBe(0o600);
  });

  test("modify returning undefined leaves the entry unchanged", async () => {
    writeFileSync(authPath, JSON.stringify({ openai: { type: "api_key", key: "keep" } }));
    const store = new FileCredentialStore(authPath);
    const result = await store.modify("openai", async () => undefined);
    expect(result).toEqual({ type: "api_key", key: "keep" });
  });

  test("delete removes a provider entry", async () => {
    writeFileSync(
      authPath,
      JSON.stringify({
        a: { type: "api_key", key: "1" },
        b: { type: "api_key", key: "2" },
      }),
    );
    const store = new FileCredentialStore(authPath);
    await store.delete("a");
    const written = JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, unknown>;
    expect(Object.keys(written)).toEqual(["b"]);
  });

  test("malformed auth.json reads as empty instead of throwing", async () => {
    writeFileSync(authPath, "not json");
    const store = new FileCredentialStore(authPath);
    expect(await store.read("anything")).toBeUndefined();
  });
});
