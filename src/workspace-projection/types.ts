import type { ContainerMount } from "../types.js";
import type { ImageWorkspaceMountMode } from "../types.js";

export interface WorkspaceProjection {
  mode: ImageWorkspaceMountMode;
  mounts: ContainerMount[];
}
