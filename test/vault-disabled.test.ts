import { describe, expect, test } from "vitest";
import { disabledVaultManager } from "../src/vault/disabled.js";
import type { SandboxConfig } from "../src/sandbox/index.js";

describe("disabledVaultManager", () => {
  test("reports the vault as disabled and empty", () => {
    expect(disabledVaultManager.isEnabled()).toBe(false);
    expect(disabledVaultManager.hasEntry("anyone")).toBe(false);
    expect(disabledVaultManager.resolve("anyone")).toBeUndefined();
    expect(disabledVaultManager.list()).toEqual([]);
    expect(disabledVaultManager.listSharedVaults()).toEqual([]);
    expect(disabledVaultManager.deleteSharedVault("shared")).toBe(false);
    expect(disabledVaultManager.copySharedVaultTo("shared", "user")).toEqual({
      filesCopied: 0,
      envKeysCopied: 0,
    });
  });

  test("returns the base sandbox config unchanged", () => {
    const baseConfig = { mode: "host" } as unknown as SandboxConfig;
    expect(disabledVaultManager.getSandboxConfig("user", baseConfig)).toBe(baseConfig);
  });

  test("fails loudly on write paths so misconfiguration surfaces", () => {
    expect(() => disabledVaultManager.upsertEnv("user", { API_KEY: "x" })).toThrow(
      "Vault not configured",
    );
    expect(() => disabledVaultManager.upsertFile("user", "creds.json", "{}")).toThrow(
      "Vault not configured",
    );
  });
});
