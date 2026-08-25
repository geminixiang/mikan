import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { InMemoryAdminTokenStore } from "../web/admin/store.js";
import { startWebServer } from "../web/server.js";
import { InMemoryLinkTokenStore } from "../web/login/store.js";
import { InMemoryWebSessionStore } from "../web/login/session-store.js";
import { FileVaultManager } from "../vault/index.js";

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

function startTestWebServer(
  port: number,
  linkTokenStore: InMemoryLinkTokenStore,
  vaultManager: FileVaultManager,
  notify: Parameters<typeof startWebServer>[0]["notify"],
  sessionViewTokenStore?: Parameters<typeof startWebServer>[0]["sessionViewTokenStore"],
  sessionViewInteractive?: Parameters<typeof startWebServer>[0]["sessionViewInteractive"],
  adminOptions?: Parameters<typeof startWebServer>[0]["adminOptions"],
): Promise<Server> {
  return startWebServer({
    port,
    linkTokenStore,
    vaultManager,
    notify,
    sessionViewTokenStore,
    sessionViewInteractive,
    adminOptions,
  }).then((server) => {
    if (server === undefined) throw new Error("web server failed to start");
    return server;
  });
}

describe("link server", () => {
  const servers: Server[] = [];
  const dirs: string[] = [];
  const originalFetch = globalThis.fetch;
  const originalGitHubClientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  const originalGitHubClientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
  const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (originalGitHubClientId === undefined) {
      delete process.env.GITHUB_OAUTH_CLIENT_ID;
    } else {
      process.env.GITHUB_OAUTH_CLIENT_ID = originalGitHubClientId;
    }
    if (originalGitHubClientSecret === undefined) {
      delete process.env.GITHUB_OAUTH_CLIENT_SECRET;
    } else {
      process.env.GITHUB_OAUTH_CLIENT_SECRET = originalGitHubClientSecret;
    }
    if (originalAnthropicApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
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

  test("/link shows stored secret names and mounted files, but not secret values", async () => {
    const stateDir = join(tmpdir(), `mikan-link-server-${Date.now()}-${Math.random()}`);
    dirs.push(stateDir);

    const vaultManager = new FileVaultManager(stateDir);
    vaultManager.upsertEnv("vault-u123", {
      OPENAI_API_KEY: "sk-secret-value",
      GH_TOKEN: "ghp-secret-value",
    });
    vaultManager.upsertFile(
      "vault-u123",
      "gws.json",
      '{\n  "type": "authorized_user"\n}\n',
      "/root/.config/gws/credentials.json",
    );

    const tokenStore = new InMemoryLinkTokenStore();
    const token = tokenStore.create("telegram", "U123", "123", "vault-u123", "");
    const server = await startTestWebServer(0, tokenStore, vaultManager, async () => {});
    servers.push(server);
    await waitForListening(server);

    const response = await originalFetch(`${baseUrl(server)}/link?token=${token.token}`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Currently stored");
    expect(html).toContain("OPENAI_API_KEY");
    expect(html).toContain("GH_TOKEN");
    expect(html).toContain("/root/.config/gws/credentials.json");
    expect(html).not.toContain("sk-secret-value");
    expect(html).not.toContain("ghp-secret-value");
  });

  test("/admin/api/models lists configured models", async () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

    const stateDir = join(tmpdir(), `mikan-link-server-${Date.now()}-${Math.random()}`);
    dirs.push(stateDir);

    const vaultManager = new FileVaultManager(stateDir);
    const tokenStore = new InMemoryLinkTokenStore();
    const adminTokenStore = new InMemoryAdminTokenStore();
    const adminToken = adminTokenStore.create({
      platform: "telegram",
      platformUserId: "U-admin",
      conversationId: "123",
    });
    const server = await startTestWebServer(
      0,
      tokenStore,
      vaultManager,
      async () => {},
      undefined,
      undefined,
      {
        adminTokenStore,
        workingDir: stateDir,
      },
    );
    servers.push(server);
    await waitForListening(server);

    const response = await originalFetch(
      `${baseUrl(server)}/admin/api/models?token=${adminToken.token}`,
    );
    const body = (await response.json()) as {
      models: Array<{ provider: string; id: string; name: string }>;
    };

    expect(response.status).toBe(200);
    expect(body.models.some((model) => model.provider === "anthropic")).toBe(true);
  });

  test("/api/link/info reports validity and existing vault secrets as JSON", async () => {
    const stateDir = join(tmpdir(), `mikan-link-server-${Date.now()}-${Math.random()}`);
    dirs.push(stateDir);

    const vaultManager = new FileVaultManager(stateDir);
    vaultManager.upsertEnv("vault-u123", { OPENAI_API_KEY: "sk-secret-value" });
    const tokenStore = new InMemoryLinkTokenStore();
    const token = tokenStore.create("telegram", "U123", "123", "vault-u123", "");
    const server = await startTestWebServer(0, tokenStore, vaultManager, async () => {});
    servers.push(server);
    await waitForListening(server);

    const response = await originalFetch(`${baseUrl(server)}/api/link/info?token=${token.token}`);
    const body = (await response.json()) as {
      valid: boolean;
      expiresAt: number;
      oauthServices: Array<{ id: string; label: string }>;
      existingSecrets: { envKeys: string[]; mountTargets: string[] };
    };

    expect(response.status).toBe(200);
    expect(body.valid).toBe(true);
    expect(body.expiresAt).toBeGreaterThan(Date.now());
    expect(body.oauthServices.length).toBeGreaterThan(0);
    expect(body.existingSecrets.envKeys).toContain("OPENAI_API_KEY");

    const invalid = await originalFetch(`${baseUrl(server)}/api/link/info?token=bogus`);
    expect(((await invalid.json()) as { valid: boolean }).valid).toBe(false);
  });

  test("web session API routes stay ahead of the SPA fallback", async () => {
    const stateDir = join(tmpdir(), `mikan-link-server-${Date.now()}-${Math.random()}`);
    dirs.push(stateDir);
    mkdirSync(stateDir, { recursive: true });

    const webDistIndex = join(stateDir, "index.html");
    writeFileSync(webDistIndex, "<!doctype html><html><body>SPA fallback</body></html>");
    const webSessionStore = new InMemoryWebSessionStore();
    const { sessionId } = webSessionStore.create("github:101", "test-user");
    const started = await startWebServer({
      port: 0,
      linkTokenStore: new InMemoryLinkTokenStore(),
      vaultManager: new FileVaultManager(stateDir),
      notify: async () => {},
      webSessionStore,
      webDistIndex,
      adminOptions: { adminTokenStore: new InMemoryAdminTokenStore() },
    });
    if (started === undefined) throw new Error("web server failed to start");
    servers.push(started);
    await waitForListening(started);

    const cookie = `mikan_session=${sessionId}`;
    const meResponse = await originalFetch(`${baseUrl(started)}/api/me`, {
      headers: { Cookie: cookie },
    });
    expect(meResponse.status).toBe(200);
    expect(meResponse.headers.get("content-type")).toContain("application/json");
    await expect(meResponse.json()).resolves.toMatchObject({
      authenticated: true,
      oauthIdentity: "github:101",
      displayName: "test-user",
    });

    const appResponse = await originalFetch(`${baseUrl(started)}/conversations/example`);
    expect(appResponse.status).toBe(200);
    expect(await appResponse.text()).toContain("SPA fallback");
    for (const path of ["/session?token=bad", "/admin?token=bad", "/link?token=bad"]) {
      const response = await originalFetch(`${baseUrl(started)}${path}`);
      expect(response.status).not.toBe(200);
      expect(await response.text()).not.toContain("SPA fallback");
    }
    const reservedChild = await originalFetch(`${baseUrl(started)}/session/unknown`);
    expect(reservedChild.status).toBe(404);
    expect(await reservedChild.text()).not.toContain("SPA fallback");
    expect((await originalFetch(`${baseUrl(started)}/api/offices`)).status).toBe(404);

    const rejectedLogout = await originalFetch(`${baseUrl(started)}/api/logout`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(rejectedLogout.status).toBe(415);

    const logoutResponse = await originalFetch(`${baseUrl(started)}/api/logout`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(logoutResponse.status).toBe(200);
    await expect(logoutResponse.json()).resolves.toEqual({ ok: true });

    const loggedOutResponse = await originalFetch(`${baseUrl(started)}/api/me`, {
      headers: { Cookie: cookie },
    });
    expect(loggedOutResponse.status).toBe(401);
    await expect(loggedOutResponse.json()).resolves.toEqual({ authenticated: false });
  });

  test("/api/oauth/start returns an OAuth redirect URL for GitHub", async () => {
    const stateDir = join(tmpdir(), `mikan-link-server-${Date.now()}-${Math.random()}`);
    dirs.push(stateDir);

    process.env.GITHUB_OAUTH_CLIENT_ID = "github-client-id";
    process.env.GITHUB_OAUTH_CLIENT_SECRET = "github-client-secret";

    const vaultManager = new FileVaultManager(stateDir);

    const tokenStore = new InMemoryLinkTokenStore();
    const token = tokenStore.create("telegram", "U234", "234", "vault-u234", "");
    const server = await startTestWebServer(0, tokenStore, vaultManager, async () => {});
    servers.push(server);
    await waitForListening(server);

    const response = await originalFetch(`${baseUrl(server)}/api/oauth/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: baseUrl(server),
      },
      body: JSON.stringify({ token: token.token, serviceId: "github" }),
    });
    const body = (await response.json()) as { redirectUrl: string };
    const redirectUrl = new URL(body.redirectUrl);

    expect(response.status).toBe(200);
    expect(redirectUrl.origin).toBe("https://github.com");
    expect(redirectUrl.pathname).toBe("/login/oauth/authorize");
    expect(redirectUrl.searchParams.get("client_id")).toBe("github-client-id");
    expect(redirectUrl.searchParams.get("redirect_uri")).toBe(`${baseUrl(server)}/oauth/callback`);
    expect(redirectUrl.searchParams.get("scope")).toContain("repo");
    expect(redirectUrl.searchParams.get("state")).toBeTruthy();
    expect(redirectUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(redirectUrl.searchParams.get("code_challenge")).toBeTruthy();
  });

  test("OAuth callback stores GitHub tokens in the vault", async () => {
    const stateDir = join(tmpdir(), `mikan-link-server-${Date.now()}-${Math.random()}`);
    dirs.push(stateDir);

    process.env.GITHUB_OAUTH_CLIENT_ID = "github-client-id";
    process.env.GITHUB_OAUTH_CLIENT_SECRET = "github-client-secret";

    const vaultManager = new FileVaultManager(stateDir);

    const tokenStore = new InMemoryLinkTokenStore();
    const token = tokenStore.create("telegram", "U345", "345", "vault-u345", "");
    const notify = vi.fn().mockResolvedValue(undefined);
    const server = await startTestWebServer(0, tokenStore, vaultManager, notify);
    servers.push(server);
    await waitForListening(server);

    const startResponse = await originalFetch(`${baseUrl(server)}/api/oauth/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: baseUrl(server),
      },
      body: JSON.stringify({ token: token.token, serviceId: "github" }),
    });
    const startBody = (await startResponse.json()) as { redirectUrl: string };
    const redirectUrl = new URL(startBody.redirectUrl);
    const state = redirectUrl.searchParams.get("state");

    expect(state).toBeTruthy();

    const tokenExchangeFetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => "application/json" },
      text: async () =>
        JSON.stringify({
          access_token: "gho_test_access_token",
          refresh_token: "ghr_test_refresh_token",
        }),
    });
    globalThis.fetch = tokenExchangeFetch as typeof fetch;

    const callbackResponse = await originalFetch(
      `${baseUrl(server)}/oauth/callback?state=${state}&code=test-code`,
    );
    const callbackHtml = await callbackResponse.text();

    expect(callbackResponse.status).toBe(200);
    expect(callbackHtml).toContain("GitHub OAuth connected successfully.");
    expect(vaultManager.resolve("vault-u345")?.env).toMatchObject({
      GITHUB_OAUTH_ACCESS_TOKEN: "gho_test_access_token",
      GH_TOKEN: "gho_test_access_token",
      GITHUB_OAUTH_REFRESH_TOKEN: "ghr_test_refresh_token",
    });
    expect(notify).toHaveBeenCalledWith(
      "telegram",
      "345",
      expect.stringContaining("GitHub OAuth stored"),
    );
    expect(tokenExchangeFetch).toHaveBeenCalledWith(
      "https://github.com/login/oauth/access_token",
      expect.objectContaining({ method: "POST" }),
    );
  });

  test("/link shows built-in preset cards and provider-specific env guidance", async () => {
    const stateDir = join(tmpdir(), `mikan-link-server-${Date.now()}-${Math.random()}`);
    dirs.push(stateDir);

    const vaultManager = new FileVaultManager(stateDir);

    const tokenStore = new InMemoryLinkTokenStore();
    const token = tokenStore.create("telegram", "U777", "777", "vault-u777", "");
    const server = await startTestWebServer(0, tokenStore, vaultManager, async () => {});
    servers.push(server);
    await waitForListening(server);

    const response = await originalFetch(`${baseUrl(server)}/link?token=${token.token}`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Cloudflare / Wrangler");
    expect(html).toContain("OpenAI");
    expect(html).toContain("Anthropic");
    expect(html).toContain("Gemini");
    expect(html).toContain("OpenRouter");
    expect(html).toContain("GitHub PAT");
    expect(html).toContain("Vercel");
    expect(html).toContain("Sentry");
    expect(html).toContain("CLOUDFLARE_API_TOKEN");
    expect(html).toContain("GOOGLE_API_KEY");
    expect(html).toContain("GITHUB_TOKEN");
    expect(html).toContain("VERCEL_PROJECT_ID");
    expect(html).toContain("SENTRY_AUTH_TOKEN");
    expect(html).toContain("Do not use the Global API Key.");
  });

  test("/api/link/complete stores Sentry env values and writes sentry-cli config", async () => {
    const stateDir = join(tmpdir(), `mikan-link-server-${Date.now()}-${Math.random()}`);
    dirs.push(stateDir);

    const vaultManager = new FileVaultManager(stateDir);

    const tokenStore = new InMemoryLinkTokenStore();
    const token = tokenStore.create("telegram", "U889", "889", "vault-u889", "");
    const notify = vi.fn().mockResolvedValue(undefined);
    const server = await startTestWebServer(0, tokenStore, vaultManager, notify);
    servers.push(server);
    await waitForListening(server);

    const response = await originalFetch(`${baseUrl(server)}/api/link/complete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: baseUrl(server),
      },
      body: JSON.stringify({
        token: token.token,
        mode: "api_key",
        env: {
          SENTRY_AUTH_TOKEN: "sntrys_test-token",
          SENTRY_ORG: "gliacloud-z3",
          SENTRY_PROJECT: "mikan",
        },
      }),
    });
    const body = (await response.json()) as { message: string };

    expect(response.status).toBe(200);
    expect(body.message).toContain("/root/.sentryclirc");
    expect(vaultManager.resolve("vault-u889")?.env).toMatchObject({
      SENTRY_AUTH_TOKEN: "sntrys_test-token",
      SENTRY_ORG: "gliacloud-z3",
      SENTRY_PROJECT: "mikan",
    });
    expect(vaultManager.resolve("vault-u889")?.mounts).toContainEqual({
      source: join(stateDir, "vaults", "vault-u889", ".sentryclirc"),
      target: "/root/.sentryclirc",
    });
    expect(readFileSync(join(stateDir, "vaults", "vault-u889", ".sentryclirc"), "utf-8")).toBe(
      `[auth]\ntoken=sntrys_test-token\n\n[defaults]\norg = gliacloud-z3\nproject = mikan\n`,
    );
    expect(notify).toHaveBeenCalledWith(
      "telegram",
      "889",
      expect.stringContaining("/root/.sentryclirc"),
    );
  });

  test("/api/link/complete stores multiple environment values from a preset payload", async () => {
    const stateDir = join(tmpdir(), `mikan-link-server-${Date.now()}-${Math.random()}`);
    dirs.push(stateDir);

    const vaultManager = new FileVaultManager(stateDir);

    const tokenStore = new InMemoryLinkTokenStore();
    const token = tokenStore.create("telegram", "U888", "888", "vault-u888", "");
    const notify = vi.fn().mockResolvedValue(undefined);
    const server = await startTestWebServer(0, tokenStore, vaultManager, notify);
    servers.push(server);
    await waitForListening(server);

    const response = await originalFetch(`${baseUrl(server)}/api/link/complete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: baseUrl(server),
      },
      body: JSON.stringify({
        token: token.token,
        mode: "api_key",
        env: {
          GEMINI_API_KEY: "AIza-test-gemini-key",
          GOOGLE_API_KEY: "AIza-test-gemini-key",
          GH_TOKEN: "github_pat_test",
          GITHUB_TOKEN: "github_pat_test",
        },
      }),
    });
    const body = (await response.json()) as { message: string };

    expect(response.status).toBe(200);
    expect(body.message).toContain("4 secrets stored successfully in vault");
    expect(vaultManager.resolve("vault-u888")?.env).toMatchObject({
      GEMINI_API_KEY: "AIza-test-gemini-key",
      GOOGLE_API_KEY: "AIza-test-gemini-key",
      GH_TOKEN: "github_pat_test",
      GITHUB_TOKEN: "github_pat_test",
    });
    expect(notify).toHaveBeenCalledWith(
      "telegram",
      "888",
      expect.stringContaining("GEMINI_API_KEY"),
    );
  });

  test("/link shows an empty-state message when the vault has no secrets yet", async () => {
    const stateDir = join(tmpdir(), `mikan-link-server-${Date.now()}-${Math.random()}`);
    dirs.push(stateDir);

    const vaultManager = new FileVaultManager(stateDir);

    const tokenStore = new InMemoryLinkTokenStore();
    const token = tokenStore.create("telegram", "U999", "999", "vault-u999", "");
    const server = await startTestWebServer(0, tokenStore, vaultManager, async () => {});
    servers.push(server);
    await waitForListening(server);

    const response = await originalFetch(`${baseUrl(server)}/link?token=${token.token}`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("No secrets are stored in this vault yet.");
  });
});
