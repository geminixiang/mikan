import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach } from "vitest";

const fallbackStateDir = mkdtempSync(join(tmpdir(), "mikan-test-state-"));

process.env.MIKAN_STATE_DIR ??= fallbackStateDir;

beforeEach(() => {
  process.env.MIKAN_STATE_DIR ??= fallbackStateDir;
});
