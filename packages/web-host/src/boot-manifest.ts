/**
 * Boot manifest (DSH client/modules pattern, simplified): the host injects a
 * JSON graph as `window.__MIKAN_BOOT__` into every served index.html, first in
 * <head> so the shell bundle reads it. For mikan's single-bundle phase the
 * graph carries the app's own entry + a content rev as a cache anchor; the
 * shape stays compatible with DSH's WebBootGraph so a per-plugin bundle split
 * can grow later without changing the wire.
 */

/** One boot row: an entry bundle the shell may load. */
export interface WebBootEntry {
  /** Entry name (module-table key). */
  id: string;
  /** Bundle endpoint. */
  url: string;
  /** Bundle content hash (cache-busting consistency anchor). */
  rev: string;
  /** Stage-one prefetch mark: load the script for factory registration during boot. */
  immediately?: boolean;
}

/** The composed client entry graph the host injects as `window.__MIKAN_BOOT__`. */
export interface WebBootGraph {
  /** Consistency anchor over the whole graph. */
  rev: string;
  /** Composed entries; order carries no semantics. */
  entries: WebBootEntry[];
}

/**
 * Inject the boot entry graph into index.html: `window.__MIKAN_BOOT__` as the
 * first script in <head> (before the shell bundle reads it). `<` is escaped in
 * the JSON so entry-controlled strings cannot break out of the script element.
 * @param html - the index.html source.
 * @param graph - the composed entry graph.
 * @returns the html with the graph script injected.
 */
export function injectBootManifest(html: string, graph: WebBootGraph): string {
  const json = JSON.stringify(graph).replaceAll("<", "\\u003c");
  const script = `<script>window.__MIKAN_BOOT__ = ${json}</script>`;
  const head = html.indexOf("<head>");
  if (head !== -1) return `${html.slice(0, head + 6)}${script}${html.slice(head + 6)}`;
  // Headless fixture pages may lack <head>; prepending keeps the read-before-shell ordering.
  return `${script}${html}`;
}

/**
 * Compute a content hash over the whole graph (entries + revs). Small, stable,
 * dependency-free hash over the JSON representation.
 */
export function graphRev(graph: WebBootGraph): string {
  let hash = 0;
  const json = JSON.stringify(graph);
  for (let i = 0; i < json.length; i++) {
    hash = (hash * 31 + json.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}
