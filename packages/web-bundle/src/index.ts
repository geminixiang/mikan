/**
 * @geminixiang/mikan-web-bundle — web composition: declares which app entry
 * ships in the bundle and builds the `window.__DSH_BOOT__` graph the host
 * injects. Phase 1 is a single app bundle (DSH's per-plugin split can grow
 * here without changing the wire shape).
 */

import { createHash } from "node:crypto";
import type { WebBootGraph } from "@geminixiang/mikan-web-host";

/** The single app entry id for the phase-1 bundle. */
export const APP_ENTRY_ID = "app";

export interface ComposeWebBootGraphOptions {
  /** The built entry bundle URL (e.g. '/assets/index-<hash>.js'). */
  entryUrl: string;
  /** The entry's content hash (cache anchor). */
  entryRev: string;
}

/** Build the boot graph for the single-bundle app. */
export function composeWebBootGraph(options: ComposeWebBootGraphOptions): WebBootGraph {
  return {
    rev: options.entryRev,
    entries: [
      {
        id: APP_ENTRY_ID,
        url: options.entryUrl,
        rev: options.entryRev,
        immediately: true,
      },
    ],
  };
}

/** SHA-256 content hash (hex, first 16 chars) of an index.html body — the boot graph rev anchor. */
export function contentRev(html: string): string {
  return createHash("sha256").update(html).digest("hex").slice(0, 16);
}

/**
 * Parse the first <script src="/assets/..."> from a built index.html; the
 * boot graph's entry URL points at the app bundle. Returns undefined when the
 * index is not a built Vite app (tests/fixtures).
 */
export function entryUrlOfIndex(html: string): string | undefined {
  const match = /<script[^>]+type="module"[^>]+src="([^"]+)"/.exec(html);
  return match?.[1] ?? undefined;
}
