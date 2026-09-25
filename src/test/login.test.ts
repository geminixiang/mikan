import { afterEach, describe, expect, test, vi } from "vitest";
import { getOAuthServices, resolveOAuthService } from "../adapters/web/login/oauth.js";
import * as log from "../log.js";

const originalOAuthServicesJson = process.env.OAUTH_SERVICES_JSON;

afterEach(() => {
  if (originalOAuthServicesJson === undefined) {
    delete process.env.OAUTH_SERVICES_JSON;
  } else {
    process.env.OAUTH_SERVICES_JSON = originalOAuthServicesJson;
  }
  vi.restoreAllMocks();
});

const customService = {
  id: "custom",
  label: "Custom",
  authorizationUrl: "https://example.com/auth",
  tokenUrl: "https://example.com/token",
  clientIdEnvKey: "CUSTOM_CLIENT_ID",
  clientSecretEnvKey: "CUSTOM_CLIENT_SECRET",
};

function configuredService(overrides: Record<string, unknown>) {
  process.env.OAUTH_SERVICES_JSON = JSON.stringify([{ ...customService, ...overrides }]);
  return getOAuthServices().find((service) => service.id === "custom");
}

describe("OAuth services", () => {
  test("warns about a non-array OAUTH_SERVICES_JSON and keeps the builtins", () => {
    const warning = vi.spyOn(log, "logWarning").mockImplementation(() => {});
    process.env.OAUTH_SERVICES_JSON = "{}";
    expect(getOAuthServices().some((service) => service.id === "custom")).toBe(false);
    expect(warning).toHaveBeenCalledWith(
      "Ignoring OAUTH_SERVICES_JSON: expected a JSON array of OAuth service definitions",
      "expected a JSON array of OAuth service definitions",
    );
  });

  test("warns about unparsable OAUTH_SERVICES_JSON as invalid JSON", () => {
    const warning = vi.spyOn(log, "logWarning").mockImplementation(() => {});
    process.env.OAUTH_SERVICES_JSON = "not json";
    getOAuthServices();
    expect(warning).toHaveBeenCalledWith(
      "Ignoring OAUTH_SERVICES_JSON: invalid JSON",
      expect.any(String),
    );
  });

  test("normalizes scalar fields and token keys without normalizing aliases or scopes", () => {
    expect(
      configuredService({
        id: " CUSTOM ",
        label: " Custom ",
        clientIdEnvKey: " ID ",
        accessTokenEnvKey: " FIRST ",
        additionalAccessTokenEnvKeys: [" SECOND ", "FIRST", "", "  "],
        accessTokenEnvKeys: ["SECOND", " third ", "FIRST"],
        refreshTokenEnvKey: " ",
        aliases: [" ALIAS "],
        scopes: [" scope "],
        authorizationParams: { prompt: " consent " },
      }),
    ).toMatchObject({
      id: "custom",
      label: "Custom",
      clientIdEnvKey: "ID",
      accessTokenEnvKeys: ["FIRST", "SECOND", "third"],
      refreshTokenEnvKey: "",
      aliases: [" alias "],
      scopes: [" scope "],
      authorizationParams: { prompt: " consent " },
    });
  });

  test("keeps absent and empty token grants undefined", () => {
    expect(configuredService({})?.accessTokenEnvKeys).toBeUndefined();
    expect(
      configuredService({ accessTokenEnvKey: 1, accessTokenEnvKeys: [" ", ""] })
        ?.accessTokenEnvKeys,
    ).toBeUndefined();
    expect(configuredService({})?.aliases).toEqual(["custom"]);
    expect(configuredService({ aliases: [] })?.aliases).toEqual([]);
  });

  test("parses authorized-user output and preserves empty optional strings", () => {
    expect(
      configuredService({
        fileOutput: {
          type: " authorized_user ",
          relativePath: " creds.json ",
          targetPath: " ",
          envKey: 1,
          additionalEnvKeys: [" RAW "],
        },
      })?.fileOutput,
    ).toEqual({
      type: "authorized_user",
      relativePath: "creds.json",
      targetPath: "",
      envKey: undefined,
      additionalEnvKeys: [" RAW "],
    });
  });

  test.each([
    null,
    [],
    "file",
    { type: "other", relativePath: "file" },
    { type: "authorized_user", relativePath: " " },
  ])("ignores unsupported file output %j without rejecting the service", (fileOutput) => {
    const service = configuredService({ fileOutput });
    expect(service).toBeDefined();
    expect(service?.fileOutput).toBeUndefined();
  });

  test.each([
    "aliases",
    "scopes",
    "authorizationParams",
    "additionalAccessTokenEnvKeys",
    "accessTokenEnvKeys",
  ])("rejects invalid %s with the existing warning", (field) => {
    const warning = vi.spyOn(log, "logWarning").mockImplementation(() => {});
    expect(configuredService({ [field]: [1] })).toBeUndefined();
    expect(warning).toHaveBeenCalledWith(
      `Skipping OAUTH_SERVICES_JSON[0] (custom): ${field} must be strings`,
    );
  });

  test("validates file env keys even for unsupported output and keeps warning precedence", () => {
    const warning = vi.spyOn(log, "logWarning").mockImplementation(() => {});
    const fileOutput = { type: "other", additionalEnvKeys: [1] };
    expect(configuredService({ fileOutput })).toBeUndefined();
    expect(warning).toHaveBeenLastCalledWith(
      "Skipping OAUTH_SERVICES_JSON[0] (custom): fileOutput.additionalEnvKeys must be strings",
    );
    warning.mockClear();
    expect(configuredService({ aliases: [1], scopes: [1], fileOutput })).toBeUndefined();
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      "Skipping OAUTH_SERVICES_JSON[0] (custom): aliases must be strings",
    );
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
    expect(resolveOAuthService("github")?.accessTokenEnvKeys).toContain("GH_TOKEN");
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

  test("skips invalid custom OAuth services with a targeted warning", () => {
    const logWarning = vi.spyOn(log, "logWarning").mockImplementation(() => {});
    process.env.OAUTH_SERVICES_JSON = JSON.stringify([
      { id: "broken", label: "Broken" },
      {
        id: "custom",
        label: "Custom",
        authorizationUrl: "https://example.com/auth",
        tokenUrl: "https://example.com/token",
        clientIdEnvKey: "CUSTOM_CLIENT_ID",
        clientSecretEnvKey: "CUSTOM_CLIENT_SECRET",
      },
    ]);

    const services = getOAuthServices();

    expect(services.some((service) => service.id === "broken")).toBe(false);
    expect(services.some((service) => service.id === "custom")).toBe(true);
    expect(logWarning).toHaveBeenCalledWith(
      "Skipping OAUTH_SERVICES_JSON[0] (broken): missing authorizationUrl, tokenUrl, clientIdEnvKey, clientSecretEnvKey",
    );
  });
});
