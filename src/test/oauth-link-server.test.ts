import { existsSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { startWebServer } from "../web/server.js";
import { WebBindingStore } from "../web/login/binding.js";
import { InMemoryLinkTokenStore } from "../web/login/store.js";
import { InMemoryWebSessionStore } from "../web/login/session-store.js";
import { FileVaultManager } from "../vault/index.js";

const originalFetch = globalThis.fetch;
const originalEnv = {
  GITHUB_OAUTH_CLIENT_ID: process.env.GITHUB_OAUTH_CLIENT_ID,
  GITHUB_OAUTH_CLIENT_SECRET: process.env.GITHUB_OAUTH_CLIENT_SECRET,
  GOOGLE_WORKSPACE_CLI_CLIENT_ID: process.env.GOOGLE_WORKSPACE_CLI_CLIENT_ID,
  GOOGLE_WORKSPACE_CLI_CLIENT_SECRET: process.env.GOOGLE_WORKSPACE_CLI_CLIENT_SECRET,
  GOOGLE_CLOUD_SDK_CLIENT_ID: process.env.GOOGLE_CLOUD_SDK_CLIENT_ID,
  GOOGLE_CLOUD_SDK_CLIENT_SECRET: process.env.GOOGLE_CLOUD_SDK_CLIENT_SECRET,
  MIKAN_LINK_URL: process.env.MIKAN_LINK_URL,
};

async function waitForListening(server: Server): Promise<void> {
  if (server.listening) return;
  await new Promise<void>((resolve) => server.once("listening", resolve));
}

function baseUrl(server: Server): string {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Link server did not expose a TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

function createStateDir(dirs: string[]): string {
  const stateDir = join(tmpdir(), `mikan-oauth-test-${Date.now()}-${Math.random()}`);
  dirs.push(stateDir);
  return stateDir;
}

function configureGitHubOAuth(): void {
  process.env.GITHUB_OAUTH_CLIENT_ID = "github-client-id";
  process.env.GITHUB_OAUTH_CLIENT_SECRET = "github-client-secret";
}

function configureGoogleOAuth(): void {
  process.env.GOOGLE_WORKSPACE_CLI_CLIENT_ID = "google-client-id";
  process.env.GOOGLE_WORKSPACE_CLI_CLIENT_SECRET = "google-client-secret";
}

function configureGcloudOAuth(): void {
  process.env.GOOGLE_CLOUD_SDK_CLIENT_ID = "gcloud-client-id";
  process.env.GOOGLE_CLOUD_SDK_CLIENT_SECRET = "gcloud-client-secret";
}

async function createFlow(
  servers: Server[],
  stateDir: string,
  userId: string,
  notify: typeof Promise.resolve extends (...args: any[]) => any
    ? () => Promise<void>
    : never = async () => {},
  serverOptions?: Pick<
    Parameters<typeof startWebServer>[0],
    "bindingTokenStore" | "webSessionStore"
  >,
): Promise<{
  server: Server;
  url: string;
  vaultManager: FileVaultManager;
  token: string;
}> {
  const vaultManager = new FileVaultManager(stateDir);
  const vaultId = `vault-${userId.toLowerCase()}`;

  const tokenStore = new InMemoryLinkTokenStore();
  const token = tokenStore.create("telegram", userId, userId.replace(/^U/, ""), vaultId, "");
  const started = await startWebServer({
    port: 0,
    linkTokenStore: tokenStore,
    vaultManager,
    notify,
    ...serverOptions,
  });
  if (started === undefined) throw new Error("web server failed to start");
  const server = started;
  servers.push(server);
  await waitForListening(server);

  return { server, url: baseUrl(server), vaultManager, token: token.token };
}

async function startOAuth(url: string, token: string, serviceId: string): Promise<URL> {
  const response = await originalFetch(`${url}/api/oauth/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: url,
    },
    body: JSON.stringify({ token, serviceId }),
  });
  const body = (await response.json()) as { redirectUrl: string };
  expect(response.status).toBe(200);
  return new URL(body.redirectUrl);
}

function mockTokenExchange(options: { ok?: boolean; contentType?: string; body: string }): void {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: options.ok ?? true,
    headers: { get: () => options.contentType ?? "application/json" },
    text: async () => options.body,
  }) as typeof fetch;
}

describe("OAuth link server flows", () => {
  const servers: Server[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();

    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
          }),
      ),
    );

    for (const dir of dirs.splice(0)) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects cross-origin OAuth start requests when MIKAN_LINK_URL is configured", async () => {
    const stateDir = createStateDir(dirs);
    process.env.MIKAN_LINK_URL = "https://mikan.example.com";
    configureGitHubOAuth();

    const { url, token } = await createFlow(servers, stateDir, "U100");
    const response = await originalFetch(`${url}/api/oauth/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://evil.example.com",
      },
      body: JSON.stringify({ token, serviceId: "github" }),
    });
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(403);
    expect(body.error).toBe("Cross-origin request rejected");
  });

  test("returns a clear error when GitHub OAuth is not configured", async () => {
    const stateDir = createStateDir(dirs);
    const { url, token } = await createFlow(servers, stateDir, "U110");

    const response = await originalFetch(`${url}/api/oauth/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: url,
      },
      body: JSON.stringify({ token, serviceId: "github" }),
    });
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toContain("GitHub is not configured");
  });

  test("web login OAuth creates a browser session", async () => {
    const stateDir = createStateDir(dirs);
    configureGitHubOAuth();
    const webSessionStore = new InMemoryWebSessionStore();
    const bindingTokenStore = new WebBindingStore();
    bindingTokenStore.bind({ id: "github:115", displayName: "test-user" }, "slack", "U115", "D115");
    const { url } = await createFlow(servers, stateDir, "U115", async () => {}, {
      bindingTokenStore,
      webSessionStore,
    });

    const startResponse = await originalFetch(`${url}/api/oauth/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: url },
      body: JSON.stringify({ token: "login", serviceId: "github", mode: "login" }),
    });
    const startBody = (await startResponse.json()) as { redirectUrl: string };
    const state = new URL(startBody.redirectUrl).searchParams.get("state");
    expect(startResponse.status).toBe(200);
    expect(state).toBeTruthy();

    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => "application/json" },
        text: async () => JSON.stringify({ access_token: "gho_web_login" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 115, login: "test-user" }),
      }) as typeof fetch;

    const callbackResponse = await originalFetch(
      `${url}/oauth/callback?state=${state}&code=login-code`,
      { redirect: "manual" },
    );
    expect(callbackResponse.status).toBe(302);
    expect(callbackResponse.headers.get("location")).toBe(`${url}/`);
    const cookie = callbackResponse.headers.get("set-cookie")?.split(";", 1)[0];
    expect(cookie).toMatch(/^mikan_session=/);

    const meResponse = await originalFetch(`${url}/api/me`, {
      headers: { Cookie: cookie ?? "" },
    });
    await expect(meResponse.json()).resolves.toMatchObject({
      authenticated: true,
      oauthIdentity: "github:115",
      displayName: "test-user",
    });
  });

  test("web login rejects OAuth identities without a chat binding", async () => {
    const stateDir = createStateDir(dirs);
    configureGitHubOAuth();
    const { url } = await createFlow(servers, stateDir, "U116", async () => {}, {
      webSessionStore: new InMemoryWebSessionStore(),
    });

    const startResponse = await originalFetch(`${url}/api/oauth/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: url },
      body: JSON.stringify({ token: "login", serviceId: "github", mode: "login" }),
    });
    const startBody = (await startResponse.json()) as { redirectUrl: string };
    const state = new URL(startBody.redirectUrl).searchParams.get("state");

    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => "application/json" },
        text: async () => JSON.stringify({ access_token: "gho_unbound_login" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 116, login: "unbound-user" }),
      }) as typeof fetch;

    const callbackResponse = await originalFetch(
      `${url}/oauth/callback?state=${state}&code=login-code`,
      { redirect: "manual" },
    );
    expect(callbackResponse.status).toBe(403);
    expect(await callbackResponse.text()).toContain("Run /login web in a private chat first");
  });

  test("renders provider authorization errors returned to the callback", async () => {
    const stateDir = createStateDir(dirs);
    configureGitHubOAuth();

    const { url, token } = await createFlow(servers, stateDir, "U120");
    const redirectUrl = await startOAuth(url, token, "github");
    const state = redirectUrl.searchParams.get("state");

    expect(state).toBeTruthy();

    const response = await originalFetch(
      `${url}/oauth/callback?state=${state}&error=access_denied`,
    );
    const html = await response.text();

    expect(response.status).toBe(400);
    expect(html).toContain("OAuth authorization failed: access_denied");
  });

  test("OAuth callback state is one-shot", async () => {
    const stateDir = createStateDir(dirs);
    configureGitHubOAuth();

    const { url, token } = await createFlow(servers, stateDir, "U200");
    const redirectUrl = await startOAuth(url, token, "github");
    const state = redirectUrl.searchParams.get("state");

    expect(state).toBeTruthy();

    mockTokenExchange({ body: JSON.stringify({ access_token: "gho_once" }) });

    const first = await originalFetch(`${url}/oauth/callback?state=${state}&code=ok`);
    const second = await originalFetch(`${url}/oauth/callback?state=${state}&code=ok`);

    expect(first.status).toBe(200);
    expect(await second.text()).toContain("OAuth state is invalid or expired");
  });

  test("OAuth callback rejects expired state even when the login link is still valid", async () => {
    const stateDir = createStateDir(dirs);
    configureGitHubOAuth();

    let now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    const { url, token } = await createFlow(servers, stateDir, "U210");
    const redirectUrl = await startOAuth(url, token, "github");
    const state = redirectUrl.searchParams.get("state");

    expect(state).toBeTruthy();

    now += 10 * 60 * 1000 + 1;
    const response = await originalFetch(`${url}/oauth/callback?state=${state}&code=late`);
    const html = await response.text();

    expect(response.status).toBe(400);
    expect(html).toContain("OAuth state is invalid or expired");
  });

  test("GitHub OAuth accepts form-encoded token responses", async () => {
    const stateDir = createStateDir(dirs);
    configureGitHubOAuth();

    const { url, token, vaultManager } = await createFlow(servers, stateDir, "U220");
    const redirectUrl = await startOAuth(url, token, "github");
    const state = redirectUrl.searchParams.get("state");

    expect(state).toBeTruthy();

    mockTokenExchange({
      contentType: "text/plain",
      body: "access_token=gho_form_encoded&refresh_token=ghr_form_encoded",
    });

    const response = await originalFetch(`${url}/oauth/callback?state=${state}&code=form`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("GitHub OAuth connected successfully.");
    expect(vaultManager.resolve("vault-u220")?.env).toMatchObject({
      GITHUB_OAUTH_ACCESS_TOKEN: "gho_form_encoded",
      GH_TOKEN: "gho_form_encoded",
      GITHUB_OAUTH_REFRESH_TOKEN: "ghr_form_encoded",
    });
  });

  test("GitHub OAuth rejects callbacks without access_token", async () => {
    const stateDir = createStateDir(dirs);
    configureGitHubOAuth();

    const { url, token, vaultManager } = await createFlow(servers, stateDir, "U230");
    const redirectUrl = await startOAuth(url, token, "github");
    const state = redirectUrl.searchParams.get("state");

    expect(state).toBeTruthy();

    mockTokenExchange({ body: JSON.stringify({ refresh_token: "ghr_only" }) });

    const response = await originalFetch(`${url}/oauth/callback?state=${state}&code=no-access`);
    const html = await response.text();

    expect(response.status).toBe(400);
    expect(html).toContain("did not return an access_token");
    expect(vaultManager.resolve("vault-u230")?.env ?? {}).toEqual({});
  });

  test("OAuth callback returns a server error when vault persistence fails", async () => {
    const stateDir = createStateDir(dirs);
    configureGitHubOAuth();

    const { url, token, vaultManager } = await createFlow(servers, stateDir, "U240");
    const redirectUrl = await startOAuth(url, token, "github");
    const state = redirectUrl.searchParams.get("state");

    expect(state).toBeTruthy();

    mockTokenExchange({ body: JSON.stringify({ access_token: "gho_ok" }) });
    (vaultManager as any).upsertEnv = vi.fn(() => {
      throw new Error("disk full");
    });

    const response = await originalFetch(`${url}/oauth/callback?state=${state}&code=store-fail`);
    const html = await response.text();

    expect(response.status).toBe(500);
    expect(html).toContain("could not be stored on the server");
  });

  test("notify failures do not break a successful GitHub OAuth callback", async () => {
    const stateDir = createStateDir(dirs);
    configureGitHubOAuth();

    const notify = vi.fn().mockRejectedValue(new Error("chat offline"));
    const { url, token, vaultManager } = await createFlow(servers, stateDir, "U250", notify);
    const redirectUrl = await startOAuth(url, token, "github");
    const state = redirectUrl.searchParams.get("state");

    expect(state).toBeTruthy();

    mockTokenExchange({ body: JSON.stringify({ access_token: "gho_notify_ok" }) });

    const response = await originalFetch(`${url}/oauth/callback?state=${state}&code=notify`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("GitHub OAuth connected successfully.");
    expect(vaultManager.resolve("vault-u250")?.env).toMatchObject({
      GITHUB_OAUTH_ACCESS_TOKEN: "gho_notify_ok",
      GH_TOKEN: "gho_notify_ok",
    });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  test("Google Workspace OAuth stores an authorized_user file mount", async () => {
    const stateDir = createStateDir(dirs);
    configureGoogleOAuth();

    const notify = vi.fn().mockResolvedValue(undefined);
    const { url, token, vaultManager } = await createFlow(servers, stateDir, "U300", notify);
    const redirectUrl = await startOAuth(url, token, "google_workspace_cli");
    const state = redirectUrl.searchParams.get("state");

    expect(state).toBeTruthy();

    mockTokenExchange({
      body: JSON.stringify({
        access_token: "ya29.access-token",
        refresh_token: "1//refresh-token",
      }),
    });

    const response = await originalFetch(`${url}/oauth/callback?state=${state}&code=google-code`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Google Workspace CLI OAuth connected successfully.");

    const vault = vaultManager.resolve("vault-u300");
    expect(vault?.env).toEqual({});
    expect(vault?.mounts).toEqual([
      {
        source: join(stateDir, "vaults", "vault-u300", "gws.json"),
        target: "/root/.config/gws/credentials.json",
      },
    ]);

    const credentialFile = join(stateDir, "vaults", "vault-u300", "gws.json");
    expect(readFileSync(credentialFile, "utf-8")).toContain('"refresh_token": "1//refresh-token"');
    expect(readFileSync(credentialFile, "utf-8")).toContain('"type": "authorized_user"');
    expect(notify).toHaveBeenCalledWith(
      "telegram",
      "300",
      expect.stringContaining("Google Workspace CLI OAuth stored"),
    );
  });

  test("Google Cloud SDK OAuth stores an ADC file and gcloud env overrides", async () => {
    const stateDir = createStateDir(dirs);
    configureGcloudOAuth();

    const { url, token, vaultManager } = await createFlow(servers, stateDir, "U350");
    const redirectUrl = await startOAuth(url, token, "gcloud");
    const state = redirectUrl.searchParams.get("state");

    expect(state).toBeTruthy();
    expect(redirectUrl.searchParams.get("scope")).toContain(
      "https://www.googleapis.com/auth/cloud-platform",
    );

    mockTokenExchange({
      body: JSON.stringify({
        access_token: "ya29.gcloud-access-token",
        refresh_token: "1//gcloud-refresh-token",
      }),
    });

    const response = await originalFetch(`${url}/oauth/callback?state=${state}&code=gcloud-code`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Google Cloud SDK (gcloud) OAuth connected successfully.");

    const target = "/root/.config/gcloud/application_default_credentials.json";
    const vault = vaultManager.resolve("vault-u350");
    expect(vault?.env).toMatchObject({
      GOOGLE_APPLICATION_CREDENTIALS: target,
      CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: target,
    });
    expect(vault?.mounts).toEqual([
      {
        source: join(stateDir, "vaults", "vault-u350", "gcloud-adc.json"),
        target,
      },
    ]);

    const credentialFile = join(stateDir, "vaults", "vault-u350", "gcloud-adc.json");
    expect(readFileSync(credentialFile, "utf-8")).toContain(
      '"refresh_token": "1//gcloud-refresh-token"',
    );
  });

  test("Google Workspace OAuth rejects callbacks without refresh_token", async () => {
    const stateDir = createStateDir(dirs);
    configureGoogleOAuth();

    const { url, token, vaultManager } = await createFlow(servers, stateDir, "U400");
    const redirectUrl = await startOAuth(url, token, "google_workspace_cli");
    const state = redirectUrl.searchParams.get("state");

    expect(state).toBeTruthy();

    mockTokenExchange({ body: JSON.stringify({ access_token: "ya29.access-token" }) });

    const response = await originalFetch(`${url}/oauth/callback?state=${state}&code=google-code`);
    const html = await response.text();

    expect(response.status).toBe(400);
    expect(html).toContain("did not return a refresh_token");
    expect(vaultManager.resolve("vault-u400")?.mounts ?? []).toEqual([]);
    expect(existsSync(join(stateDir, "vaults", "vault-u400", "gws.json"))).toBe(false);
  });
});
