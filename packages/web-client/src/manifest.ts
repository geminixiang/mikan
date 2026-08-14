/**
 * Client-side boot manifest (mirror of the host's WebBootGraph). The host
 * injects `window.__MIKAN_BOOT__` into index.html; the shell parses it here.
 */

/** One boot row: an entry bundle the shell may load. */
export interface WebBootEntry {
  id: string;
  url: string;
  rev: string;
  immediately?: boolean;
}

/** The composed client entry graph the host injects. */
export interface WebBootGraph {
  rev: string;
  entries: WebBootEntry[];
}

declare global {
  interface Window {
    __MIKAN_BOOT__?: unknown;
  }
}

/**
 * Parse `window.__MIKAN_BOOT__`. A missing or malformed graph throws (the shell
 * shows the loud failure — a page without a valid manifest cannot boot).
 */
export function parseBootManifest(wire: unknown): WebBootGraph {
  if (typeof wire !== "object" || wire === null) {
    throw new Error("web-client: window.__MIKAN_BOOT__ is missing or not an object");
  }
  const graph = wire as Record<string, unknown>;
  if (typeof graph.rev !== "string") {
    throw new Error("web-client: boot manifest rev must be a string");
  }
  if (!Array.isArray(graph.entries)) {
    throw new Error("web-client: boot manifest entries must be an array");
  }
  const entries: WebBootEntry[] = [];
  for (const value of graph.entries as unknown[]) {
    if (typeof value !== "object" || value === null) {
      throw new Error("web-client: boot manifest entry is not an object");
    }
    const row = value as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.url !== "string" || typeof row.rev !== "string") {
      throw new Error("web-client: boot manifest entry must carry string id/url/rev");
    }
    entries.push({
      id: row.id,
      url: row.url,
      rev: row.rev,
      ...(row.immediately === true ? { immediately: true } : {}),
    });
  }
  return { rev: graph.rev, entries };
}
