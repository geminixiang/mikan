export function formatToolArgs(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  const lines: string[] = [];

  for (const [key, value] of Object.entries(args)) {
    if (key === "label" || key === "offset" || key === "limit") continue;

    if (key === "path" && typeof value === "string") {
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;
      lines.push(
        offset !== undefined && limit !== undefined
          ? `${value}:${offset}-${offset + limit}`
          : value,
      );
      continue;
    }

    lines.push(typeof value === "string" ? value : JSON.stringify(value));
  }

  return lines.join("\n");
}
