import { readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { FileVaultManager } from "../vault/index.js";
import type { WebOAuthProviderConfig } from "../web/auth/portal.js";
import { WebAuthRegistry } from "../web/auth/registry.js";
import { InMemoryLinkTokenStore } from "../web/login/store.js";
import { startWebServer } from "../web/server.js";

const originalFetch = globalThis.fetch;
const dirs: string[] = [];
const servers: Server[] = [];

const github: WebOAuthProviderConfig = {
  provider: "github",
  clientId: "github-client",
  clientSecret: "github-secret",
  authorizationUrl: "https://github.example/authorize",
  tokenUrl: "https://github.example/token",
  profileUrl: "https://github.example/user",
  scopes: ["read:user", "user:email"],
};

const google: WebOAuthProviderConfig = {
  provider: "google",
  clientId: "google-client",
  clientSecret: "google-secret",
  authorizationUrl: "https://google.example/authorize",
  tokenUrl: "https://google.example/token",
  profileUrl: "https://google.example/userinfo",
  scopes: ["openid", "email", "profile"],
};

async function waitForListening(server: Server): Promise<void> {
  if (server.listening) return;
  await new Promise<void>((resolve) => server.once("listening", resolve));
}

function baseUrl(server: Server): string {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  return `http://127.0.0.1:${address.port}`;
}

async function createServer(): Promise<{ url: string; registry: WebAuthRegistry }> {
  const dir = join(tmpdir(), `mikan-web-auth-http-${Date.now()}-${Math.random()}`);
  dirs.push(dir);
  const registry = new WebAuthRegistry(dir);
  const server = startWebServer({
    port: 0,
    linkTokenStore: new InMemoryLinkTokenStore(),
    vaultManager: new FileVaultManager(dir),
    notify: async () => {},
    webAuth: { registry, providers: { github, google } },
  });
  servers.push(server);
  await waitForListening(server);
  return { url: baseUrl(server), registry };
}

function cookieHeader(response: Response): string {
  const values = response.headers.getSetCookie();
  return values.map((value) => value.split(";", 1)[0]).join("; ");
}

function cookieValue(cookies: string, name: string): string {
  const entry = cookies.split("; ").find((value) => value.startsWith(`${name}=`));
  if (!entry) throw new Error(`Missing ${name} cookie`);
  return decodeURIComponent(entry.slice(name.length + 1));
}

function mockGitHubProvider(): void {
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === github.tokenUrl) {
      return new Response("access_token=gho_login", {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
    }
    if (url === github.profileUrl) {
      return Response.json({
        id: 12345,
        login: "octocat",
        name: "Octo Cat",
        email: "octo@example.test",
        avatar_url: "https://avatars.example/octo",
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
}

function mockGoogleProvider(): void {
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === google.tokenUrl) return Response.json({ access_token: "google-login-token" });
    if (url === google.profileUrl) {
      return Response.json({
        sub: "google-subject",
        name: "Example User",
        email: "person@example.test",
        email_verified: true,
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
}

async function beginOAuth(
  url: string,
  provider: "github" | "google",
  returnTo = "/",
): Promise<URL> {
  const response = await originalFetch(
    `${url}/auth/${provider}?returnTo=${encodeURIComponent(returnTo)}`,
    {
      redirect: "manual",
    },
  );
  expect(response.status).toBe(302);
  return new URL(response.headers.get("location")!);
}

async function finishOAuth(
  url: string,
  provider: "github" | "google",
  authorization: URL,
): Promise<Response> {
  return originalFetch(
    `${url}/auth/${provider}/callback?state=${authorization.searchParams.get("state")}&code=ok`,
    { redirect: "manual" },
  );
}

afterEach(async () => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Web account authentication", () => {
  test("lists configured providers and builds least-privilege PKCE authorization URLs", async () => {
    const { url } = await createServer();

    const providers = await originalFetch(`${url}/auth/providers`);
    await expect(providers.json()).resolves.toEqual({ providers: ["github", "google"] });

    const authorization = await beginOAuth(url, "github", "/w/wsp_example");
    expect(authorization.origin).toBe("https://github.example");
    expect(authorization.searchParams.get("client_id")).toBe("github-client");
    expect(authorization.searchParams.get("redirect_uri")).toBe(`${url}/auth/github/callback`);
    expect(authorization.searchParams.get("scope")).toBe("read:user user:email");
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("code_challenge")).toBeTruthy();
  });

  test("signs in with GitHub, rotates a browser session, and supports me and logout", async () => {
    const { url, registry } = await createServer();
    mockGitHubProvider();
    const authorization = await beginOAuth(url, "github", "/w/wsp_example");

    const callback = await finishOAuth(url, "github", authorization);
    const cookies = cookieHeader(callback);
    const csrf = cookieValue(cookies, "mikan_web_csrf");
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/w/wsp_example");
    expect(callback.headers.getSetCookie().join("\n")).toContain("mikan_web_session=");
    expect(callback.headers.getSetCookie().join("\n")).toContain("HttpOnly");
    expect(callback.headers.getSetCookie().join("\n")).not.toContain("gho_login");

    const me = await originalFetch(`${url}/api/web/me`, { headers: { Cookie: cookies } });
    expect(me.status).toBe(200);
    await expect(me.json()).resolves.toMatchObject({
      account: { displayName: "Octo Cat" },
      csrfToken: csrf,
    });

    const logout = await originalFetch(`${url}/api/web/logout`, {
      method: "POST",
      headers: {
        Cookie: cookies,
        Origin: url,
        "Content-Type": "application/json",
        "X-Mikan-CSRF": csrf,
      },
      body: "{}",
    });
    expect(logout.status).toBe(204);
    expect(registry.snapshot().sessionCount).toBe(0);

    const denied = await originalFetch(`${url}/api/web/me`, { headers: { Cookie: cookies } });
    expect(denied.status).toBe(401);
    const persisted = readFileSync(join(dirs[0]!, "web", "registry.json"), "utf8");
    expect(persisted).not.toContain("gho_login");
    expect(persisted).not.toContain(cookieValue(cookies, "mikan_web_session"));
  });

  test("keeps same-email GitHub and Google identities in separate accounts", async () => {
    const { url, registry } = await createServer();
    mockGitHubProvider();
    const githubAuthorization = await beginOAuth(url, "github");
    await finishOAuth(url, "github", githubAuthorization);

    mockGoogleProvider();
    const googleAuthorization = await beginOAuth(url, "google");
    await finishOAuth(url, "google", googleAuthorization);

    expect(registry.snapshot().accounts).toHaveLength(2);
    expect(registry.snapshot().identities).toHaveLength(2);
  });

  test("consumes callback state once and rejects provider mismatch", async () => {
    const { url } = await createServer();
    mockGitHubProvider();
    const authorization = await beginOAuth(url, "github");
    const state = authorization.searchParams.get("state");

    const mismatch = await originalFetch(`${url}/auth/google/callback?state=${state}&code=ok`, {
      redirect: "manual",
    });
    expect(mismatch.status).toBe(400);

    const first = await finishOAuth(url, "github", authorization);
    const replay = await finishOAuth(url, "github", authorization);
    expect(first.status).toBe(302);
    expect(replay.status).toBe(400);
  });

  test("rejects unsafe return paths and cross-origin logout", async () => {
    const { url } = await createServer();
    const unsafe = await originalFetch(
      `${url}/auth/github?returnTo=${encodeURIComponent("//evil.test")}`,
      {
        redirect: "manual",
      },
    );
    expect(unsafe.status).toBe(400);

    const logout = await originalFetch(`${url}/api/web/logout`, {
      method: "POST",
      headers: { Origin: "https://evil.test", "Content-Type": "application/json" },
      body: "{}",
    });
    expect(logout.status).toBe(403);
  });
});
