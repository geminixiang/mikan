import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { HostExecutor } from "../sandbox/host.js";
import { createEditTool } from "../harness/tools/edit.js";

/**
 * The edit tool's `details.diff` is what the agent and the channel see after a
 * change, so its exact spelling is the contract: gutter width, the `+`/`-`/` `
 * markers, how much context survives around a change, and where the `...`
 * elision markers fall. These cases pin that rendering, including the quirk
 * that context lines following an elision are renumbered from the start of the
 * run rather than from their real position in the file.
 */

const numbered = (from: number, to: number): string =>
  Array.from({ length: to - from + 1 }, (_, i) => `line-${String(from + i).padStart(3, "0")}`).join(
    "\n",
  );

const CASES: Array<
  [name: string, content: string, oldText: string, newText: string, diff: string]
> = [
  [
    "single line, short file",
    "a\nb\nc\n",
    "b",
    "B",
    ` 1 a
-2 b
+2 B
 3 c`,
  ],
  [
    "insert only",
    "a\nb\nc\n",
    "b\n",
    "b\nnew1\nnew2\n",
    ` 1 a
 2 b
+3 new1
+4 new2
 3 c`,
  ],
  [
    "delete only",
    "a\nb\nc\nd\n",
    "b\nc\n",
    "",
    ` 1 a
-2 b
-3 c
 4 d`,
  ],
  [
    "change at head of long file",
    `${numbered(1, 30)}\n`,
    "line-002",
    "LINE TWO",
    `  1 line-001
- 2 line-002
+ 2 LINE TWO
  3 line-003
  4 line-004
  5 line-005
  6 line-006
    ...`,
  ],
  [
    "change at tail of long file",
    `${numbered(1, 30)}\n`,
    "line-029",
    "LINE 29",
    `    ...
  1 line-025
  2 line-026
  3 line-027
  4 line-028
-29 line-029
+29 LINE 29
 30 line-030`,
  ],
  [
    "change in middle of long file",
    `${numbered(1, 30)}\n`,
    "line-015",
    "LINE 15",
    `    ...
  1 line-011
  2 line-012
  3 line-013
  4 line-014
-15 line-015
+15 LINE 15
 16 line-016
 17 line-017
 18 line-018
 19 line-019
    ...`,
  ],
  [
    "two hunks far apart",
    `${numbered(1, 40)}\n`,
    "line-005\nline-006",
    "FIVE\nSIX",
    `  1 line-001
  2 line-002
  3 line-003
  4 line-004
- 5 line-005
- 6 line-006
+ 5 FIVE
+ 6 SIX
  7 line-007
  8 line-008
  9 line-009
 10 line-010
    ...`,
  ],
  [
    "multi-line grow",
    `${numbered(1, 20)}\n`,
    "line-010",
    "X\nY\nZ",
    `    ...
  1 line-006
  2 line-007
  3 line-008
  4 line-009
-10 line-010
+10 X
+11 Y
+12 Z
 11 line-011
 12 line-012
 13 line-013
 14 line-014
    ...`,
  ],
  [
    "multi-line shrink",
    `${numbered(1, 20)}\n`,
    "line-009\nline-010\nline-011",
    "ONE",
    `    ...
  1 line-005
  2 line-006
  3 line-007
  4 line-008
- 9 line-009
-10 line-010
-11 line-011
+ 9 ONE
 12 line-012
 13 line-013
 14 line-014
 15 line-015
    ...`,
  ],
  [
    "no trailing newline",
    "a\nb\nc",
    "b",
    "B",
    ` 1 a
-2 b
+2 B
 3 c`,
  ],
  [
    "exactly context-sized gap",
    `${numbered(1, 12)}\n`,
    "line-004",
    "FOUR",
    `  1 line-001
  2 line-002
  3 line-003
- 4 line-004
+ 4 FOUR
  5 line-005
  6 line-006
  7 line-007
  8 line-008
    ...`,
  ],
  [
    "three digit line numbers",
    `${numbered(1, 120)}\n`,
    "line-060",
    "SIXTY",
    `     ...
   1 line-056
   2 line-057
   3 line-058
   4 line-059
- 60 line-060
+ 60 SIXTY
  61 line-061
  62 line-062
  63 line-063
  64 line-064
     ...`,
  ],
];

describe("edit tool diff rendering", () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `mikan-edit-diff-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  test.each(CASES)("%s", async (name, content, oldText, newText, diff) => {
    const path = join(dir, `${name.replace(/\W+/g, "_")}.txt`);
    writeFileSync(path, content);
    const result = (await createEditTool(new HostExecutor()).execute("1", {
      label: "edit",
      path,
      oldText,
      newText,
    })) as { details: { diff: string } };
    expect(result.details.diff).toBe(diff);
  });
});
