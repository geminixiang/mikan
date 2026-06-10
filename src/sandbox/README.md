# src/sandbox

This directory defines the sandbox provider SPI, the provider registry, and the built-in providers.

The control plane (`ActorExecutionResolver`, agent runner, commands) never switches on sandbox
types; it only consults each provider's declared `capabilities` (lifecycle, credential scope, env
injection, file mounts) and calls `acquire()` to obtain a ready `SandboxInstance`.

## Files

- `spi.ts`: The stable provider interface: `SandboxProvider`, `SandboxInstance`, `SandboxCapabilities`, and `AcquireContext`.
- `registry.ts`: Provider registration (`registerSandboxProvider`), parse/validate/attach helpers, and capability-driven `resolveActorScopeKey`.
- `scope.ts`: Scope-key segment sanitisation shared by routing, container naming, and derived sandbox ids.
- `errors.ts`: Defines `SandboxError`, which can render user-facing CLI diagnostics.
- `path-context.ts`: Builds mounted runtime path contexts and translates runtime paths back to host paths.
- `types.ts`: Sandbox config types, the legacy `Executor` contract (a subset of `SandboxInstance`), exec results, and runtime path contexts.
- `utils.ts`: Simple child-process execution, process-tree killing, and shell escaping.
- `index.ts`: Public exports for the SPI, registry, and built-in providers.

## Providers (`providers/`)

- `host.ts`: Runs commands directly through the local shell. Credentials are user-scoped and never injected.
- `docker/container.ts`: Attaches to an existing Docker container (`container:<name>`); one container, one credential scope.
- `docker/image.ts`: Managed per-conversation containers (`image:<image>`); acquires instances via the provisioner with vault/workspace mounts.
- `docker/provisioner.ts`: `DockerContainerManager` — container lifecycle, networks, mounts, resource limits, boost, and idle shutdown.
- `firecracker.ts`: Runs commands over SSH inside a user-managed Firecracker VM.
- `cloudflare.ts`: Calls a Cloudflare Worker bridge; derives per-scope remote sandbox ids at acquire time.

Third-party providers (e.g. E2B, gondolin) can be plugged in via `registerSandboxProvider()`
without touching the control plane.
