export type {
  CloudflareSandboxConfig,
  ContainerSandboxConfig,
  ExecOptions,
  ExecResult,
  Executor,
  FirecrackerSandboxConfig,
  HostSandboxConfig,
  ImageSandboxConfig,
  RuntimePathContext,
  SandboxConfig,
} from "./types.js";
export type {
  AcquireContext,
  ActorRef,
  CredentialScope,
  SandboxCapabilities,
  SandboxFs,
  SandboxInstance,
  SandboxLifecycle,
  SandboxProvider,
} from "./spi.js";
export { SandboxError } from "./errors.js";
export { sanitizeScopeSegment } from "./scope.js";
export { HostExecutor } from "./providers/host.js";
export { ContainerExecutor } from "./providers/docker/container.js";
export { FirecrackerExecutor } from "./providers/firecracker.js";
export { CloudflareSandboxExecutor } from "./providers/cloudflare.js";
export { DockerContainerManager } from "./providers/docker/provisioner.js";
export type { ContainerMount, ResourceLimits } from "../types.js";
export {
  createExecutor,
  createSandboxProviderFor,
  getSandboxProvider,
  getSandboxProviders,
  parseSandboxArg,
  registerSandboxProvider,
  resolveActorScopeKey,
  validateSandbox,
  type SandboxProviderDeps,
  type SandboxProviderFactory,
} from "./registry.js";
