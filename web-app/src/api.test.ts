import { afterEach, describe, expect, test, vi } from "vitest";
import { WebApi } from "./api.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("WebApi", () => {
  test("keeps CSRF in memory and sends it only on same-origin JSON mutations", async () => {
    const fetchMock = vi.fn(async () => Response.json({ workspace: { id: "wsp_one" } }));
    globalThis.fetch = fetchMock as typeof fetch;
    const api = new WebApi();
    api.setSession({
      account: {
        id: "acct_one",
        displayName: "Example",
        createdAt: 1,
        updatedAt: 1,
      },
      csrfToken: "csrf-secret",
      expiresAt: 2,
    });

    await api.createWorkspace("Research");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/web/workspaces",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-Mikan-CSRF": "csrf-secret",
        },
        body: JSON.stringify({ name: "Research" }),
      }),
    );
  });

  test("rejects mutations after the in-memory session is cleared", async () => {
    const api = new WebApi();
    await expect(api.cancel("wsp_one")).rejects.toEqual(
      expect.objectContaining({ status: 401, message: "Your session has expired." }),
    );
  });

  test("maps structured HTTP failures to ApiError", async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json({ error: "Workspace not found" }, { status: 404 }),
    ) as typeof fetch;
    const api = new WebApi();

    await expect(api.listSessions("wsp_missing")).rejects.toEqual(
      expect.objectContaining({ status: 404, message: "Workspace not found" }),
    );
  });
});
