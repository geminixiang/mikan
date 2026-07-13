import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import {
  GithubApiError,
  GithubClient,
  githubIsRateLimited,
} from "../src/adapters/github/client.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY_PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function tokenResponse(): Response {
  return jsonResponse({
    token: "ghs_installation",
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
}

function makeClient(fetchImpl: typeof fetch): GithubClient {
  return new GithubClient({
    appId: "12345",
    privateKey: PRIVATE_KEY_PEM,
    installationId: "678",
    fetchImpl,
  });
}

describe("GithubClient auth", () => {
  test("signs a verifiable RS256 app JWT with the app id as issuer", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), headers: init?.headers as Record<string, string> });
      return jsonResponse({ slug: "mikan" });
    });

    const client = makeClient(fetchImpl as unknown as typeof fetch);
    expect(await client.getAppSlug()).toBe("mikan");

    const auth = calls[0].headers.Authorization;
    expect(auth).toMatch(/^Bearer /);
    const [header, payload, signature] = auth.slice("Bearer ".length).split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(claims.iss).toBe("12345");
    expect(claims.exp).toBeGreaterThan(claims.iat);
    const verified = createVerify("RSA-SHA256")
      .update(`${header}.${payload}`)
      .verify(publicKey, Buffer.from(signature, "base64url"));
    expect(verified).toBe(true);
  });

  test("mints the installation token once and reuses it while fresh", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), headers: init?.headers as Record<string, string> });
      if (String(url).includes("/access_tokens")) return tokenResponse();
      return jsonResponse([]);
    });

    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await client.listIssuesSince("o", "r", "2026-01-01T00:00:00Z");
    await client.listIssueCommentsSince("o", "r", "2026-01-01T00:00:00Z");

    const tokenCalls = calls.filter((call) => call.url.includes("/access_tokens"));
    expect(tokenCalls).toHaveLength(1);
    const apiCalls = calls.filter((call) => call.url.includes("/repos/"));
    expect(apiCalls).toHaveLength(2);
    for (const call of apiCalls) {
      expect(call.headers.Authorization).toBe("Bearer ghs_installation");
    }
  });
});

describe("GithubClient conditional requests", () => {
  test("stores the etag and returns null on 304", async () => {
    let sentIfNoneMatch: string | undefined;
    let first = true;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("/access_tokens")) return tokenResponse();
      const headers = init?.headers as Record<string, string>;
      if (first) {
        first = false;
        return jsonResponse([{ id: 1 }], { headers: { etag: 'W/"abc"' } });
      }
      sentIfNoneMatch = headers["If-None-Match"];
      return new Response(null, { status: 304 });
    });

    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const since = "2026-01-01T00:00:00Z";
    expect(await client.listIssueCommentsSince("o", "r", since)).toEqual([{ id: 1 }]);
    expect(await client.listIssueCommentsSince("o", "r", since)).toBeNull();
    expect(sentIfNoneMatch).toBe('W/"abc"');
  });
});

describe("GithubClient review comments", () => {
  test("listPullReviewCommentsSince polls /pulls/comments conditionally", async () => {
    const calls: string[] = [];
    let first = true;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/access_tokens")) return tokenResponse();
      calls.push(String(url));
      if (first) {
        first = false;
        return jsonResponse([{ id: 8001 }], { headers: { etag: 'W/"rc"' } });
      }
      return new Response(null, { status: 304 });
    });

    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const since = "2026-01-01T00:00:00Z";
    expect(await client.listPullReviewCommentsSince("o", "r", since)).toEqual([{ id: 8001 }]);
    expect(await client.listPullReviewCommentsSince("o", "r", since)).toBeNull();
    expect(calls[0]).toContain("/repos/o/r/pulls/comments?sort=updated&direction=asc&since=");
  });

  test("listPullReviewComments and createReviewCommentReaction hit the pulls endpoints", async () => {
    const calls: { url: string; method?: string }[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("/access_tokens")) return tokenResponse();
      calls.push({ url: String(url), method: init?.method });
      return jsonResponse([]);
    });

    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await client.listPullReviewComments("o", "r", 5);
    await client.createReviewCommentReaction("o", "r", 8001, "eyes");

    expect(calls[0].url).toContain("/repos/o/r/pulls/5/comments?per_page=100");
    expect(calls[1]).toMatchObject({ method: "POST" });
    expect(calls[1].url).toContain("/repos/o/r/pulls/comments/8001/reactions");
  });
});

describe("GithubClient errors", () => {
  test("non-2xx responses throw GithubApiError with the status", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/access_tokens")) return tokenResponse();
      return new Response("API rate limit exceeded", { status: 403 });
    });

    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const failure = await client.getIssue("o", "r", 1).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(GithubApiError);
    expect((failure as GithubApiError).status).toBe(403);
    expect(githubIsRateLimited(failure as Error)).toBe(true);
  });

  test("githubIsRateLimited only matches rate-limit shapes", () => {
    expect(githubIsRateLimited(new GithubApiError(429, "GET", "/x", "slow down"))).toBe(true);
    expect(githubIsRateLimited(new GithubApiError(403, "GET", "/x", "forbidden"))).toBe(false);
    expect(githubIsRateLimited(new GithubApiError(500, "GET", "/x", "boom"))).toBe(false);
    expect(githubIsRateLimited(new Error("rate limit"))).toBe(false);
  });
});
