import { describe, expect, test, vi } from "vitest";
import { createConnectorToolPack } from "../connector/tool-pack.js";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content[0]?.text ?? "";
}

describe("createConnectorToolPack", () => {
  test("tools report unavailable before any bind", async () => {
    const pack = createConnectorToolPack({ execute: vi.fn() });
    const gws = pack.tools.find((tool) => tool.name === "connector_gws")!;
    await expect(gws.execute("id", { action: "gmail_search", query: "q" })).rejects.toThrow(
      /not configured/,
    );
  });

  test("gws actions map to curated names with validated inputs", async () => {
    const execute = vi.fn().mockResolvedValue("{}");
    const pack = createConnectorToolPack({ execute });
    const ctx = { conversationId: "C1", platformName: "slack", userId: "U1" };
    pack.bindRun(ctx);
    const gws = pack.tools.find((tool) => tool.name === "connector_gws")!;

    await gws.execute("id", { action: "gmail_search", query: "is:unread", maxResults: 5 });
    expect(execute).toHaveBeenLastCalledWith(
      ctx,
      "gmail_search",
      { query: "is:unread", maxResults: 5 },
      undefined,
    );

    await gws.execute("id", { action: "calendar_list_events" });
    expect(execute).toHaveBeenLastCalledWith(
      ctx,
      "calendar_list_events",
      { calendarId: "primary", singleEvents: true },
      undefined,
    );

    await gws.execute("id", { action: "sheets_read_range", spreadsheetId: "S1", range: "A1:B2" });
    expect(execute).toHaveBeenLastCalledWith(
      ctx,
      "sheets_read_range",
      { spreadsheetId: "S1", range: "A1:B2" },
      undefined,
    );
  });

  test("missing required fields fail before reaching the gateway", async () => {
    const execute = vi.fn();
    const pack = createConnectorToolPack({ execute });
    pack.bindRun({ conversationId: "C1", platformName: "slack", userId: "U1" });
    const gws = pack.tools.find((tool) => tool.name === "connector_gws")!;

    await expect(gws.execute("id", { action: "gmail_search" })).rejects.toThrow(/'query'/);
    await expect(gws.execute("id", { action: "gmail_read_thread" })).rejects.toThrow(/'threadId'/);
    await expect(
      gws.execute("id", { action: "sheets_read_range", spreadsheetId: "S1" }),
    ).rejects.toThrow(/'range'/);
    expect(execute).not.toHaveBeenCalled();
  });

  test("github tool maps whoami and my_repositories and returns the result text", async () => {
    const execute = vi.fn().mockResolvedValue('{"login":"someone"}');
    const pack = createConnectorToolPack({ execute });
    const ctx = { conversationId: "C1", platformName: "telegram", userId: "U2" };
    pack.bindRun(ctx);
    const github = pack.tools.find((tool) => tool.name === "connector_github")!;

    const result = await github.execute("id", { action: "whoami" });
    expect(execute).toHaveBeenLastCalledWith(ctx, "github_whoami", {}, undefined);
    expect(textOf(result)).toContain("someone");

    await github.execute("id", { action: "my_repositories" });
    expect(execute).toHaveBeenLastCalledWith(ctx, "github_my_repositories", {}, undefined);
  });

  test("rebinding switches the run context for subsequent calls", async () => {
    const execute = vi.fn().mockResolvedValue("{}");
    const pack = createConnectorToolPack({ execute });
    const gws = pack.tools.find((tool) => tool.name === "connector_gws")!;

    pack.bindRun({ conversationId: "C1", platformName: "slack", userId: "U1" });
    await gws.execute("id", { action: "gmail_search", query: "a" });
    pack.bindRun({ conversationId: "C2", platformName: "slack", userId: "U9" });
    await gws.execute("id", { action: "gmail_search", query: "b" });

    expect(execute.mock.calls[0][0]).toMatchObject({ conversationId: "C1", userId: "U1" });
    expect(execute.mock.calls[1][0]).toMatchObject({ conversationId: "C2", userId: "U9" });
  });
});
