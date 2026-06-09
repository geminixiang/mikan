# src/sandbox

This directory defines sandbox abstractions, concrete sandbox executors, and shared sandbox utilities.

## Files

- `cloudflare.ts`: Implements the Cloudflare Sandbox bridge executor, argument parsing, health checks, and remote `/exec` calls.
- `container.ts`: Implements the Docker container executor, `docker exec` command construction, secure env files, and runtime bootstrap.
- `errors.ts`: Defines `SandboxError`, which can render user-facing CLI diagnostics.
- `firecracker.ts`: Implements the Firecracker VM executor by running commands over SSH inside the VM.
- `host.ts`: Implements the host executor by running commands directly through the local shell.
- `image.ts`: Parses and validates `image:<image>` sandbox configs, which must later resolve to a concrete container executor.
- `index.ts`: Registers sandbox adapters and exposes parse, validate, and executor factory helpers.
- `path-context.ts`: Builds mounted runtime path contexts and translates runtime paths back to host paths.
- `types.ts`: Defines all sandbox configs, executors, exec results, runtime path contexts, and adapter types.
- `utils.ts`: Provides simple child-process execution, process-tree killing, and shell escaping.
