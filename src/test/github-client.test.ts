import { describe, expect, test, vi } from "vitest";
import { GithubApiError, GithubClient, githubIsRateLimited } from "../adapters/github/client.js";

type FetchInput = Parameters<typeof fetch>[0];

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function makeClient(fetchImpl: typeof fetch): GithubClient {
  return new GithubClient({ token: "github_pat_agent", fetchImpl });
}

function authOf(fetchImpl: ReturnType<typeof vi.fn>, path: string): string | undefined {
  const init = fetchImpl.mock.calls.find(([url]) => String(url).endsWith(path))?.[1] as
    | RequestInit
    | undefined;
  return (init?.headers as Record<string, string> | undefined)?.Authorization;
}

describe("GithubClient job logs", () => {
  test.each([
    [200, "plain log\nnot JSON"],
    [204, ""],
  ])("reads text for status %i", async (status, expected) => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(status === 204 ? null : expected, { status }));
    expect(await makeClient(fetchImpl).getJobLog("o", "r", 7)).toBe(expected);
    expect(fetchImpl).toHaveBeenLastCalledWith(
      "https://api.github.com/repos/o/r/actions/jobs/7/logs",
      expect.objectContaining({ method: "GET" }),
    );
  });

  test.each([304, 403, 404, 500])("rejects unsuccessful text response %i", async (status) => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(status === 304 ? null : "failure", { status }));
    await expect(makeClient(fetchImpl).getJobLog("o", "r", 7)).rejects.toMatchObject({ status });
  });
});

describe("GithubClient auth", () => {
  test("every request, read or write, uses the agent token", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 1, login: "acme-agent" }));
    const client = makeClient(fetchImpl);

    expect(await client.getAuthenticatedUser()).toEqual({ id: 1, login: "acme-agent" });
    await client.getIssue("o", "r", 5);
    await client.createIssueComment("o", "r", 5, "hi");
    await client.replyToReviewComment("o", "r", 5, 12, "reply");

    for (const path of [
      "/user",
      "/repos/o/r/issues/5",
      "/repos/o/r/issues/5/comments",
      "/repos/o/r/pulls/5/comments/12/replies",
    ]) {
      expect(authOf(fetchImpl, path)).toBe("Bearer github_pat_agent");
    }
  });
});

describe("GithubClient CI", () => {
  test("reads commit statuses, workflow runs for a sha, and their jobs", async () => {
    const fetchImpl = vi.fn(async (url: FetchInput) => {
      const path = String(url);
      if (path.includes("/status")) return jsonResponse({ sha: "abc", statuses: [] });
      if (path.includes("/jobs")) return jsonResponse({ jobs: [{ id: 42 }] });
      return jsonResponse({ workflow_runs: [{ id: 10, name: "CI" }] });
    });
    const client = makeClient(fetchImpl);

    expect(await client.getCombinedStatus("o", "r", "pi/fix")).toEqual({
      sha: "abc",
      statuses: [],
    });
    expect(await client.listWorkflowRuns("o", "r", "abc")).toEqual([{ id: 10, name: "CI" }]);
    expect(await client.listWorkflowJobs("o", "r", 10)).toEqual([{ id: 42 }]);

    const urls = fetchImpl.mock.calls.map(([url]) => String(url));
    expect(urls).toEqual([
      "https://api.github.com/repos/o/r/commits/pi%2Ffix/status?per_page=100",
      "https://api.github.com/repos/o/r/actions/runs?head_sha=abc&per_page=20",
      "https://api.github.com/repos/o/r/actions/runs/10/jobs?per_page=100",
    ]);
  });
});

describe("GithubClient review comments", () => {
  test("listPullReviewComments and createReviewCommentReaction hit the pulls endpoints", async () => {
    const calls: { url: string; method?: string }[] = [];
    const fetchImpl = vi.fn(async (url: FetchInput, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method });
      return jsonResponse([]);
    });

    const client = makeClient(fetchImpl);
    await client.listPullReviewComments("o", "r", 5);
    await client.createReviewCommentReaction("o", "r", 8001, "eyes");

    expect(calls[0]?.url).toContain("/repos/o/r/pulls/5/comments?per_page=100");
    expect(calls[1]).toMatchObject({ method: "POST" });
    expect(calls[1]?.url).toContain("/repos/o/r/pulls/comments/8001/reactions");
  });
});

describe("GithubClient errors", () => {
  test("non-2xx responses throw GithubApiError with the status", async () => {
    const fetchImpl = vi.fn(async () => new Response("API rate limit exceeded", { status: 403 }));

    const client = makeClient(fetchImpl);
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

describe("GithubClient empty responses", () => {
  test("rejects an empty body where a resource is required, naming the request", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(makeClient(fetchImpl).getRepository("o", "r")).rejects.toThrow(
      "GitHub GET /repos/o/r returned no body (204)",
    );
  });

  test("accepts an empty body for requests without a result", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(makeClient(fetchImpl).deleteIssueComment("o", "r", 1)).resolves.toBeUndefined();
  });
});
