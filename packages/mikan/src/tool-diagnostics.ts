// Central policy for what tool diagnostics are posted back to chat surfaces.
// Detailed tool calls/results still remain in the structured session history and session view.
const QUIET_TOOL_DIAGNOSTICS = new Set(["bash", "read", "write", "edit"]);

export function shouldSurfaceToolDiagnostic(toolName: string): boolean {
  return !QUIET_TOOL_DIAGNOSTICS.has(toolName);
}
