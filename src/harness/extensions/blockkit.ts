/**
 * Action-id namespacing for extension-posted interactive messages.
 *
 * Blocks posted through `api.blockkit.post` get every `action_id` rewritten
 * to `ext:<slug>:<original>` so the platform adapter can route interactions
 * exclusively to the owning extension's `onAction` handlers (never into an
 * agent run). Model-posted blocks carry no prefix and keep the existing
 * conversation-event path; the two worlds cannot collide because extension
 * slugs are admin-controlled, filesystem-safe identifiers (no `:`).
 */

export const EXT_ACTION_PREFIX = "ext:";

/** Deep-clone blocks, rewriting every `action_id` to `ext:<slug>:<id>`. */
export function namespaceActionIds<T>(blocks: T, slug: string): T {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "action_id" && typeof value === "string") {
        out[key] = `${EXT_ACTION_PREFIX}${slug}:${value}`;
      } else {
        out[key] = walk(value);
      }
    }
    return out;
  };
  return walk(blocks) as T;
}

/** Parse an `ext:<slug>:<actionId>` routing id; null for non-extension actions. */
export function parseExtActionId(actionId: string): { slug: string; actionId: string } | null {
  if (!actionId.startsWith(EXT_ACTION_PREFIX)) return null;
  const rest = actionId.slice(EXT_ACTION_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator <= 0 || separator === rest.length - 1) return null;
  return { slug: rest.slice(0, separator), actionId: rest.slice(separator + 1) };
}
