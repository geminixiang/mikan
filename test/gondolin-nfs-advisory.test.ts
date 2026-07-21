import { describe, expect, test, vi } from "vitest";
import { checkWorkspaceExported } from "../src/sandbox/gondolin-nfs-advisory.js";

function capture(deps: Parameters<typeof checkWorkspaceExported>[2]): string {
  const lines: string[] = [];
  checkWorkspaceExported("/Users/me/workspace", "100.103.8.20", {
    ...deps,
    emit: (l) => lines.push(l),
  });
  return lines.join("\n");
}

describe("gondolin:remote NFS advisory", () => {
  test("stays quiet when the workspace is already exported (mac)", () => {
    const out = capture({
      os: "darwin",
      run: () => "Exports list on localhost:\n/Users/me/workspace  100.64.0.0",
    });
    expect(out).toBe("");
  });

  test("stays quiet when already exported (linux)", () => {
    const out = capture({
      os: "linux",
      run: () => "/Users/me/workspace 100.64.0.0/10",
    });
    expect(out).toBe("");
  });

  test("prints mac setup when not exported", () => {
    const out = capture({
      os: "darwin",
      run: () => "Exports list on localhost:", // nothing exported
    });
    expect(out).toContain("/etc/exports");
    expect(out).toContain("sudo nfsd enable");
    expect(out).toContain("mount -t nfs");
    expect(out).toContain("100.103.8.20:/Users/me/workspace"); // gateway hostname threaded in
  });

  test("prints linux setup when not exported", () => {
    const out = capture({
      os: "linux",
      run: () => "", // nothing exported
    });
    expect(out).toContain("exportfs -ra");
    expect(out).toContain("systemctl enable --now nfs-server");
    expect(out).toContain("all_squash");
    expect(out).toContain("mount -t nfs");
  });

  test("treats a missing NFS tool as not exported (prints setup)", () => {
    const out = capture({
      os: "darwin",
      run: () => {
        throw new Error("showmount: command not found");
      },
    });
    expect(out).toContain("/etc/exports");
  });

  test("warns without crashing on an unsupported host OS", () => {
    const warn = vi.spyOn(console, "log").mockImplementation(() => {});
    const lines: string[] = [];
    checkWorkspaceExported("/ws", undefined, { os: "win32", emit: (l) => lines.push(l) });
    expect(lines).toEqual([]); // no setup printed, just a logWarning
    warn.mockRestore();
  });
});
