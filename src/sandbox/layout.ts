export const SANDBOX_LAYOUT_VERSION = "1";

export const GUEST_WORKSPACE_ROOT = "/workspace";
export const GUEST_PUBLIC_OFFICES_DIR = `${GUEST_WORKSPACE_ROOT}/public`;
const GUEST_HOME = "/root";

export function guestWorkspacePath(relativePath: string): string {
  return `${GUEST_WORKSPACE_ROOT}/${relativePath.replace(/^\/+/, "")}`;
}

export function guestPublicOfficePath(officeKey: string): string {
  return `${GUEST_PUBLIC_OFFICES_DIR}/${officeKey}`;
}

export function guestHomePath(relativePath: string): string {
  return `${GUEST_HOME}/${relativePath.replace(/^\/+/, "")}`;
}
