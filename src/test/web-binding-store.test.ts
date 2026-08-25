import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { WebBindingStore } from "../web/login/binding.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("WebBindingStore", () => {
  test("persists completed admission bindings but not pending proof codes", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "mikan-web-binding-"));
    dirs.push(stateDir);
    const store = new WebBindingStore(stateDir);
    const { code } = store.create("slack", "U1", "D1");
    store.bind({ id: "github:101", displayName: "octo" }, "slack", "U1", "D1");

    const restarted = new WebBindingStore(stateDir);
    expect(restarted.peek(code)).toBeUndefined();
    expect(restarted.resolveByOAuthIdentity("github:101")).toMatchObject({
      oauthDisplayName: "octo",
      platform: "slack",
      platformUserId: "U1",
      conversationId: "D1",
    });
    expect(statSync(join(stateDir, "web-bindings.json")).mode & 0o777).toBe(0o600);
  });
});
