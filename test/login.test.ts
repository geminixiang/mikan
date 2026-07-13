import { afterEach, describe, expect, test, vi } from "vitest";
import { getOAuthServices, resolveOAuthService } from "../src/web/login/oauth.js";
import * as log from "../src/log.js";

const originalOAuthServicesJson = process.env.OAUTH_SERVICES_JSON;

afterEach(() => {
  if (originalOAuthServicesJson === undefined) {
    delete process.env.OAUTH_SERVICES_JSON;
  } else {
    process.env.OAUTH_SERVICES_JSON = originalOAuthServicesJson;
  }
  vi.restoreAllMocks();
});

describe("OAuth services", () => {
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
