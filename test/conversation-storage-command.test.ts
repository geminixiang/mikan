import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runConversationStorageMigration } from "../src/cli/migrate-conversation-storage.js";
import { credentialAuthorizationKey } from "../src/sandbox/identity.js";
import { conversationStorageScope } from "../src/sessions/conversation-storage-scope.js";
import {
  invalidateConversationStorageCompletion,
  writeConversationStorageCompletion,
} from "../src/sessions/conversation-storage-migration.js";
import { FileVaultManager } from "../src/vault/index.js";

let root = "";

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

function fixture() {
  root = mkdtempSync(join(tmpdir(), "mikan-storage-command-"));
  const stateDir = join(root, "state");
  const workspaceRoot = join(root, "workspace");
  const manifestPath = join(root, "owners.json");
  mkdirSync(stateDir);
  mkdirSync(join(workspaceRoot, "123"), { recursive: true });
  writeFileSync(
    manifestPath,
    JSON.stringify({ version: 1, complete: true, owners: { "123": "discord" } }),
  );
  return { stateDir, workspaceRoot, manifestPath };
}

const sandbox = { type: "image", image: "ubuntu" } as const;

describe("conversation storage migration command", () => {
  test("moves workspace and vault before publishing completion", async () => {
    const paths = fixture();
    const vault = new FileVaultManager(paths.stateDir);
    const legacyKey = credentialAuthorizationKey(sandbox, { userId: "", conversationId: "123" });
    vault.upsertEnv(legacyKey, { TOKEN: "secret" });
    mkdirSync(join(paths.stateDir, "conversations", "123"), { recursive: true });
    writeFileSync(
      join(paths.stateDir, "conversations", "123", "settings.json"),
      JSON.stringify({ llm: { model: "legacy-model" } }),
    );

    const results = await runConversationStorageMigration({ ...paths, sandbox });

    const scope = conversationStorageScope("discord", "123");
    const scopedKey = credentialAuthorizationKey(sandbox, {
      userId: "",
      conversationId: scope.storageKey,
    });
    expect(results[0]).toMatchObject({ storageKey: scope.storageKey, migratedLegacy: true });
    expect(vault.resolve(legacyKey)).toBeUndefined();
    expect(vault.resolve(scopedKey)?.env).toEqual({ TOKEN: "secret" });
    expect(
      JSON.parse(
        readFileSync(
          join(paths.stateDir, "conversations", scope.storageKey, "settings.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ llm: { model: "legacy-model" } });
    expect(existsSync(join(paths.stateDir, "conversations", "123"))).toBe(false);
    expect(existsSync(join(paths.stateDir, "conversation-storage-v1.ready.json"))).toBe(true);
  });

  test("does not publish completion when conversation settings authorities conflict", async () => {
    const paths = fixture();
    const scope = conversationStorageScope("discord", "123");
    mkdirSync(join(paths.stateDir, "conversations", "123"), { recursive: true });
    mkdirSync(join(paths.stateDir, "conversations", scope.storageKey), { recursive: true });
    writeConversationStorageCompletion({
      stateDir: paths.stateDir,
      workspaceRoot: paths.workspaceRoot,
      manifest: { version: 1, complete: true, owners: {} },
    });

    await expect(runConversationStorageMigration({ ...paths, sandbox })).rejects.toThrow(
      "Conversation settings migration conflict",
    );
    expect(existsSync(join(paths.stateDir, "conversation-storage-v1.ready.json"))).toBe(false);
  });

  test("completion invalidation is idempotent", () => {
    const paths = fixture();
    invalidateConversationStorageCompletion(paths.stateDir);
    invalidateConversationStorageCompletion(paths.stateDir);
    expect(existsSync(join(paths.stateDir, "conversation-storage-v1.ready.json"))).toBe(false);
  });

  test("does not publish completion when vault authorities conflict", async () => {
    const paths = fixture();
    const vault = new FileVaultManager(paths.stateDir);
    const scope = conversationStorageScope("discord", "123");
    const legacyKey = credentialAuthorizationKey(sandbox, { userId: "", conversationId: "123" });
    const scopedKey = credentialAuthorizationKey(sandbox, {
      userId: "",
      conversationId: scope.storageKey,
    });
    vault.upsertEnv(legacyKey, { TOKEN: "old" });
    vault.upsertEnv(scopedKey, { TOKEN: "new" });

    await expect(runConversationStorageMigration({ ...paths, sandbox })).rejects.toThrow(
      "Vault migration conflict",
    );
    expect(existsSync(join(paths.stateDir, "conversation-storage-v1.ready.json"))).toBe(false);
  });
});
