import { describe, expect, test } from "vitest";
import {
  getOAuthServices,
  parseLoginCommand,
  resolveOAuthService,
} from "../src/web/login/index.js";

describe("login command parsing", () => {
  test("parseLoginCommand recognizes login commands only", () => {
    expect(parseLoginCommand("/login")).toEqual({ command: "/login", action: "setup" });
    expect(parseLoginCommand("login")).toEqual({ command: "login", action: "setup" });
    expect(parseLoginCommand("/login github_oauth")).toEqual({
      command: "/login",
      action: "setup",
    });
    expect(parseLoginCommand("/pi-login github")).toEqual({
      command: "/pi-login",
      action: "setup",
    });
    expect(parseLoginCommand("/pi-login shared create gliaclaw")).toEqual({
      command: "/pi-login",
      action: "shared_create",
      name: "gliaclaw",
    });
    expect(parseLoginCommand("/pi-login shared update gliaclaw")).toEqual({
      command: "/pi-login",
      action: "shared_update",
      name: "gliaclaw",
    });
    expect(parseLoginCommand("/pi-login shared delete gliaclaw")).toEqual({
      command: "/pi-login",
      action: "shared_delete",
      name: "gliaclaw",
    });
    expect(parseLoginCommand("/pi-login shared list")).toEqual({
      command: "/pi-login",
      action: "shared_list",
    });
    expect(parseLoginCommand("/pi-login copy gliaclaw")).toEqual({
      command: "/pi-login",
      action: "copy_shared",
      name: "gliaclaw",
    });
    expect(parseLoginCommand("help")).toBeNull();
  });

  test("resolveOAuthService returns known services and aliases", () => {
    expect(resolveOAuthService("github")?.id).toBe("github");
    expect(resolveOAuthService("github_oauth")?.id).toBe("github");
    expect(resolveOAuthService("gws")?.id).toBe("google_workspace_cli");
    expect(resolveOAuthService("gcloud")?.id).toBe("google_cloud_sdk");
    expect(resolveOAuthService("gcp")?.id).toBe("google_cloud_sdk");
    expect(getOAuthServices().some((s) => s.id === "github")).toBe(true);
    expect(getOAuthServices().some((s) => s.id === "google_workspace_cli")).toBe(true);
    expect(getOAuthServices().some((s) => s.id === "google_cloud_sdk")).toBe(true);
    expect(resolveOAuthService("github")?.additionalAccessTokenEnvKeys).toContain("GH_TOKEN");
    expect(resolveOAuthService("google_workspace_cli")?.fileOutput).toEqual({
      type: "authorized_user",
      relativePath: "gws.json",
      targetPath: "/root/.config/gws/credentials.json",
    });
    expect(resolveOAuthService("google_cloud_sdk")?.fileOutput).toEqual({
      type: "authorized_user",
      relativePath: "gcloud-adc.json",
      targetPath: "/root/.config/gcloud/application_default_credentials.json",
      envKey: "GOOGLE_APPLICATION_CREDENTIALS",
      additionalEnvKeys: ["CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE"],
    });
  });
});
