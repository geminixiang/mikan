/**
 * Keep tests out of the developer's real state dir.
 *
 * Host-global state (settings, the office registry) resolves its directory
 * from `MIKAN_STATE_DIR` and falls back to `~/.mikan`. A test that exercises
 * a state-writing path without setting the variable would silently write into
 * the developer's actual installation — office records from log fixtures and
 * `{}` settings markers have both leaked this way. The global hook restores a
 * per-worker temp fallback before every test, including after tests that
 * `delete process.env.MIKAN_STATE_DIR` in their own cleanup.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach } from "vitest";

const fallbackStateDir = mkdtempSync(join(tmpdir(), "mikan-test-state-"));

process.env.MIKAN_STATE_DIR ??= fallbackStateDir;

beforeEach(() => {
  process.env.MIKAN_STATE_DIR ??= fallbackStateDir;
});
