/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Composer, SafeMarkdown } from "./App.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SafeMarkdown", () => {
  test("renders GFM without raw HTML and secures external links", () => {
    const { container } = render(
      <SafeMarkdown>
        {
          "| A | B |\n| - | - |\n| 1 | 2 |\n\n<script>bad()</script>\n\n[Docs](https://example.test)"
        }
      </SafeMarkdown>,
    );
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>bad()</script>");
    expect(screen.getByRole("link", { name: "Docs" })).toMatchObject({
      target: "_blank",
      rel: "noopener noreferrer",
    });
  });
});

describe("Composer", () => {
  test("sends idle prompts with Enter and preserves a request id for retry", async () => {
    const submissions: Array<{ text: string; mode: string; clientRequestId: string }> = [];
    const onSubmit = vi.fn(async (text: string, mode: string, clientRequestId: string) => {
      submissions.push({ text, mode, clientRequestId });
      if (submissions.length === 1) throw new Error("admission failed");
    });
    render(<Composer runStatus={null} queue={[]} onSubmit={onSubmit} onCancel={vi.fn()} />);

    const input = screen.getByRole("textbox", { name: "Message mikan" });
    fireEvent.change(input, { target: { value: "ship it" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByRole("button", { name: "Retry" });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(submissions[0]?.mode).toBe("prompt");
    expect(submissions[1]?.clientRequestId).toBe(submissions[0]?.clientRequestId);
    expect(input).toHaveValue("");
  });

  test("supports follow-up, steering, queued state, and cancel", async () => {
    const onSubmit = vi.fn(async () => {});
    const onCancel = vi.fn(async () => {});
    render(
      <Composer
        runStatus="running"
        queue={[{ requestId: "req_queue", mode: "followUp", text: "queued message" }]}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByText("queued message")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Message mode" }), {
      target: { value: "steer" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Message mikan" }), {
      target: { value: "change direction" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith("change direction", "steer", expect.any(String)),
    );

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
