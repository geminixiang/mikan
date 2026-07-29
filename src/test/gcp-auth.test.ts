import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GcpAuthError, GcpTokenProvider } from "../adapters/github/gcp-auth.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY_PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("GcpTokenProvider", () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `mikan-gcp-auth-${Date.now()}-${Math.random()}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeCredentials(name: string, body: object): string {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(body));
    return path;
  }

  test("external_account with a file source exchanges at STS", async () => {
    const subjectPath = join(dir, "subject.token");
    writeFileSync(subjectPath, "oidc-subject-token\n");
    const credentialsPath = writeCredentials("wif.json", {
      type: "external_account",
      audience:
        "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/x",
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      token_url: "https://sts.googleapis.com/v1/token",
      credential_source: { file: subjectPath },
    });

    const calls: { url: string; body?: string }[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body as string });
      return jsonResponse({ access_token: "sts-token", expires_in: 3600 });
    });

    const provider = new GcpTokenProvider({
      credentialsPath,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(await provider.getAccessToken()).toBe("sts-token");
    expect(calls[0].url).toBe("https://sts.googleapis.com/v1/token");
    const form = new URLSearchParams(calls[0].body);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:token-exchange");
    expect(form.get("subject_token")).toBe("oidc-subject-token");
    expect(form.get("scope")).toBe("https://www.googleapis.com/auth/cloud-platform");
  });

  test("external_account with impersonation follows with generateAccessToken", async () => {
    const subjectPath = join(dir, "subject.token");
    writeFileSync(subjectPath, "subject");
    const impersonationUrl =
      "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/ci@p.iam.gserviceaccount.com:generateAccessToken";
    const credentialsPath = writeCredentials("wif-sa.json", {
      type: "external_account",
      audience: "aud",
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      token_url: "https://sts.googleapis.com/v1/token",
      service_account_impersonation_url: impersonationUrl,
      credential_source: { file: subjectPath },
    });

    const calls: { url: string; auth?: string }[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url: String(url), auth: headers.Authorization });
      if (String(url).includes("sts.googleapis.com")) {
        return jsonResponse({ access_token: "sts-token", expires_in: 3600 });
      }
      return jsonResponse({
        accessToken: "impersonated-token",
        expireTime: new Date(Date.now() + 3600_000).toISOString(),
      });
    });

    const provider = new GcpTokenProvider({
      credentialsPath,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(await provider.getAccessToken()).toBe("impersonated-token");
    expect(calls[1].url).toBe(impersonationUrl);
    expect(calls[1].auth).toBe("Bearer sts-token");
  });

  test("tokens are cached until near expiry and minted single-flight", async () => {
    const subjectPath = join(dir, "subject.token");
    writeFileSync(subjectPath, "subject");
    const credentialsPath = writeCredentials("wif.json", {
      type: "external_account",
      audience: "aud",
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      token_url: "https://sts.googleapis.com/v1/token",
      credential_source: { file: subjectPath },
    });

    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: "t", expires_in: 3600 }));
    const provider = new GcpTokenProvider({
      credentialsPath,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await Promise.all([provider.getAccessToken(), provider.getAccessToken()]);
    await provider.getAccessToken();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("an expiring token is re-minted", async () => {
    const subjectPath = join(dir, "subject.token");
    writeFileSync(subjectPath, "subject");
    const credentialsPath = writeCredentials("wif.json", {
      type: "external_account",
      audience: "aud",
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      token_url: "https://sts.googleapis.com/v1/token",
      credential_source: { file: subjectPath },
    });

    // expires_in below the 5-minute refresh margin → every call re-mints.
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: "t", expires_in: 10 }));
    const provider = new GcpTokenProvider({
      credentialsPath,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await provider.getAccessToken();
    await provider.getAccessToken();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("service_account keys use the JWT assertion grant", async () => {
    const credentialsPath = writeCredentials("sa.json", {
      type: "service_account",
      client_email: "ci@p.iam.gserviceaccount.com",
      private_key: PRIVATE_KEY_PEM,
    });

    const calls: { url: string; body?: string }[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body as string });
      return jsonResponse({ access_token: "sa-token", expires_in: 3600 });
    });

    const provider = new GcpTokenProvider({
      credentialsPath,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(await provider.getAccessToken()).toBe("sa-token");
    expect(calls[0].url).toBe("https://oauth2.googleapis.com/token");
    const form = new URLSearchParams(calls[0].body);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(form.get("assertion")).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
  });

  test("authorized_user uses the refresh-token grant", async () => {
    const credentialsPath = writeCredentials("user.json", {
      type: "authorized_user",
      client_id: "cid",
      client_secret: "secret",
      refresh_token: "rt",
    });

    const calls: { body?: string }[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ body: init?.body as string });
      return jsonResponse({ access_token: "user-token", expires_in: 3600 });
    });

    const provider = new GcpTokenProvider({
      credentialsPath,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(await provider.getAccessToken()).toBe("user-token");
    const form = new URLSearchParams(calls[0].body);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("rt");
  });

  test("unsupported credential types and sources fail with clear errors", async () => {
    const badTypePath = writeCredentials("bad.json", { type: "impersonated_service_account" });
    const provider = new GcpTokenProvider({ credentialsPath: badTypePath });
    await expect(provider.getAccessToken()).rejects.toThrow(/Unsupported GCP credential type/);

    const awsPath = writeCredentials("aws.json", {
      type: "external_account",
      audience: "aud",
      subject_token_type: "t",
      token_url: "https://sts.googleapis.com/v1/token",
      credential_source: { environment_id: "aws1" },
    });
    const awsProvider = new GcpTokenProvider({ credentialsPath: awsPath });
    await expect(awsProvider.getAccessToken()).rejects.toThrow(
      /only file and url sources are supported/,
    );

    const missing = new GcpTokenProvider({ credentialsPath: join(dir, "nope.json") });
    await expect(missing.getAccessToken()).rejects.toThrow(GcpAuthError);
  });

  test("a failed STS exchange surfaces status and detail", async () => {
    const subjectPath = join(dir, "subject.token");
    writeFileSync(subjectPath, "subject");
    const credentialsPath = writeCredentials("wif.json", {
      type: "external_account",
      audience: "aud",
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      token_url: "https://sts.googleapis.com/v1/token",
      credential_source: { file: subjectPath },
    });

    const fetchImpl = vi.fn(async () => new Response("invalid_grant", { status: 400 }));
    const provider = new GcpTokenProvider({
      credentialsPath,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(provider.getAccessToken()).rejects.toThrow(
      /STS token exchange failed with 400: invalid_grant/,
    );
  });
});
