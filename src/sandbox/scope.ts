/**
 * Normalise an actor-provided value (conversation id, user id) into a scope
 * key segment safe for vault directories, container names, and sandbox ids.
 */
export function sanitizeScopeSegment(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "unknown";
}
