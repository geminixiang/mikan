import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { saveIncomingAttachments } from "../src/adapters/shared.js";
import { createOfficeAddress, createWorkspace, type Office } from "../src/office/index.js";

const temporaryDirectories: string[] = [];

function makeOffice(): { office: Office; root: string } {
  const root = join(tmpdir(), `mikan-attachments-${Date.now()}-${Math.random()}`);
  mkdirSync(join(root, "workspace"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  temporaryDirectories.push(root);
  const workspace = createWorkspace({
    root: join(root, "workspace"),
    stateDir: join(root, "state"),
  });
  return { office: workspace.office(createOfficeAddress("slack", "C1")), root };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("saveIncomingAttachments", () => {
  test("owns the attachment convention: sanitized timestamped names, office-relative paths", async () => {
    const { office } = makeOffice();

    const { saved, failed } = await saveIncomingAttachments(office, [
      {
        name: "my report (final).pdf",
        timestampMs: 1234567890123,
        download: (destPath) => writeFile(destPath, "content"),
      },
    ]);

    expect(failed).toEqual([]);
    expect(saved).toEqual([
      {
        original: "my report (final).pdf",
        localPath: `${office.key}/attachments/1234567890123_my_report__final_.pdf`,
      },
    ]);
    const onDisk = join(office.attachmentsDir, "1234567890123_my_report__final_.pdf");
    expect(readFileSync(onDisk, "utf-8")).toBe("content");
  });

  test("partitions failures without losing successful downloads", async () => {
    const { office } = makeOffice();

    const { saved, failed } = await saveIncomingAttachments(office, [
      { name: "good.txt", download: (destPath) => writeFile(destPath, "ok") },
      {
        name: "bad.txt",
        download: () => Promise.reject(new Error("network down")),
      },
    ]);

    expect(saved).toEqual([
      { original: "good.txt", localPath: expect.stringMatching(/\/attachments\/\d+_good\.txt$/) },
    ]);
    expect(failed).toEqual([{ name: "bad.txt", error: expect.any(Error) }]);
  });

  test("materializes the office before its first write", async () => {
    const { office } = makeOffice();
    expect(existsSync(office.dir)).toBe(false);

    await saveIncomingAttachments(office, [
      { name: "first.txt", download: (destPath) => writeFile(destPath, "x") },
    ]);

    expect(lstatSync(office.dir).isDirectory()).toBe(true);
    expect(lstatSync(office.attachmentsDir).isDirectory()).toBe(true);
  });

  test("no items: no office materialization, no directories", async () => {
    const { office } = makeOffice();

    const outcome = await saveIncomingAttachments(office, []);

    expect(outcome).toEqual({ saved: [], failed: [] });
    expect(existsSync(office.dir)).toBe(false);
  });
});
