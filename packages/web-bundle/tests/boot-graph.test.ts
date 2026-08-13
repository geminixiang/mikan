import { describe, expect, it } from "vitest";
import { composeWebBootGraph, contentRev, entryUrlOfIndex } from "../src/index.js";

describe("web-bundle boot graph", () => {
  it("composes a single-entry boot graph", () => {
    const graph = composeWebBootGraph({ entryUrl: "/assets/index-abc.js", entryRev: "rev1" });
    expect(graph.rev).toBe("rev1");
    expect(graph.entries).toEqual([
      { id: "app", url: "/assets/index-abc.js", rev: "rev1", immediately: true },
    ]);
  });

  it("contentRev is stable and content-sensitive", () => {
    const a = contentRev("<!DOCTYPE html>");
    const b = contentRev("<!DOCTYPE html>");
    const c = contentRev("<!DOCTYPE html><div>other</div>");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("extracts the module entry URL from a built index.html", () => {
    const html = '<script type="module" src="/assets/index-xyz.js"></script>';
    expect(entryUrlOfIndex(html)).toBe("/assets/index-xyz.js");
  });

  it("entryUrlOfIndex returns undefined for non-built fixtures", () => {
    expect(entryUrlOfIndex("<!DOCTYPE html><body></body>")).toBeUndefined();
  });
});
