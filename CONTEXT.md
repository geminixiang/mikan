# Code Context

## Files Retrieved

1. `src/vault/index.ts` (lines 1-260) - file-backed vault storage, env parsing/merging, resolved vault shape, shared vault copying.
2. `src/vault/types.ts` (lines 1-40) - `ResolvedVault`/`VaultManager` interfaces used by runtime and login portal.
3. `src/web/login/portal.ts` (lines 40-260, 300-560, 820-1180, 1218-1460) - `/link` UI, presets/manual env payload JS, API completion handler, env validation/persistence.
4. `src/sandbox/credential-policy.ts` (lines 1-85) - current per-command allowlist for vault env injection.
5. `src/execution-resolver.ts` (lines 1-230) - resolves vault by actor/conversation and passes vault env/mounts into executors except host.
6. `src/sandbox/container.ts` (lines 1-113) - Docker `exec` env injection via `resolveCommandEnv`.
7. `src/sandbox/cloudflare.ts` (lines 1-180) - Cloudflare bridge payload env injection via `resolveCommandEnv`.
8. `src/sandbox/firecracker.ts` (lines 200-280) - Firecracker currently exports all provided env before every command.
9. `src/sandbox/host.ts` (lines 1-111) - host executor ignores injected vault env.
10. `test/vault.test.ts` (lines 1-480) - vault persistence, shared vaults, actor resolver, image mount/env behavior tests.
11. `test/login.test.ts` (lines 1-86) - login command/OAuth service parsing tests only.
12. `test/sandbox.test.ts` (lines 1-320) - sandbox parsing and current container/cloudflare credential-policy tests.

## Key Code

### Vault env storage

`src/vault/index.ts`:

```ts
export function parseEnvFile(content: string): Record<string, string> { ... }

upsertEnv(key: string, env: Record<string, string>): void {
  const existing = existingContent ? parseEnvFile(existingContent) : {};
  const merged = { ...existing, ...env };
  const content = Object.entries(merged)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([envKey, value]) => `${envKey}=${value}`)
    .join("\n") + "\n";
  atomicWritePrivateFile(envPath, content);
}
```

- Values are persisted as raw `KEY=value` lines, sorted, private file perms.
- `buildResolved()` returns all parsed env in `ResolvedVault.env`.
- No CLI metadata is stored today; only flat env key/value pairs.

### `/pi-login` UI/API env payload

`src/web/login/portal.ts`:

```ts
interface LinkCompleteBody {
  token: string;
  mode?: LoginCredentialKind;
  envKey?: string;
  credential?: string;
  env?: Record<string, string>;
}
```

Preset definitions currently encode known env keys in UI only (`SECRET_PRESETS`): Cloudflare/Wrangler, OpenAI, Anthropic, Gemini, OpenRouter, GitHub PAT, Vercel, Sentry.

Browser JS collects either preset env keys or arbitrary manual key:

```js
body: JSON.stringify({ token: "...", mode: "api_key", env: payload.env });
```

Server-side handling:

```ts
function extractEnvUpdates(data: Partial<LinkCompleteBody>) {
  if (data.env && typeof data.env === "object" && !Array.isArray(data.env)) {
    for (const [rawKey, rawValue] of Object.entries(data.env)) {
      const envKey = rawKey.trim();
      const credential = typeof rawValue === "string" ? rawValue.trim() : "";
      if (!isValidEnvKey(envKey)) return { error: `Invalid envKey format: ${rawKey}` };
      if (!credential) return { error: `Missing value for envKey: ${envKey}` };
      updates[envKey] = credential;
    }
    return { updates };
  }
  ...legacy envKey/credential...
}
```

Then `handleLinkComplete()` consumes the token and calls `vaultManager.upsertEnv(linkToken.vaultId, updates)`. API accepts any valid env key; it does not verify keys against presets or any exposure policy.

Existing UI exposure behavior:

- `/link` always renders all `SECRET_PRESETS` plus manual entry.
- Existing vault summary displays env key names only, never values.
- No current modes for All commands / Selected CLIs / Never.

### Sandbox env policy

`src/execution-resolver.ts` passes vault env to executors for non-host sandboxes only:

```ts
const env = config.type !== "host" && vault && Object.keys(vault.env).length > 0 ? vault.env : undefined;
return createExecutor(config, env, ...);
```

`src/sandbox/credential-policy.ts` currently defines known CLI env keys globally:

```ts
const CLI_ENV_POLICIES = [
  { cliNames: ["gh"], envKeys: ["GH_TOKEN", "GITHUB_TOKEN", "GITHUB_OAUTH_ACCESS_TOKEN"] },
  {
    cliNames: ["gcloud", "gsutil", "bq"],
    envKeys: [
      "GOOGLE_APPLICATION_CREDENTIALS",
      "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE",
      "CLOUDSDK_CONFIG",
    ],
  },
  { cliNames: ["wrangler"], envKeys: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"] },
  { cliNames: ["vercel"], envKeys: ["VERCEL_TOKEN", "VERCEL_ORG_ID", "VERCEL_PROJECT_ID"] },
  { cliNames: ["sentry-cli"], envKeys: ["SENTRY_AUTH_TOKEN", "SENTRY_ORG", "SENTRY_PROJECT"] },
];
```

`resolveCommandEnv(command, vaultEnv)` detects only first CLI token (with support for `command`, `npx`/`bunx`, `pnpm dlx`/`yarn dlx`) and returns env keys from matching policy. If no match or no matching keys, returns `undefined`.

Current per-sandbox behavior:

- `container.ts`: injects only `resolveCommandEnv()` result as `docker exec -e KEY=value ...`.
- `cloudflare.ts`: sends only `resolveCommandEnv()` result in bridge JSON `payload.env`.
- `firecracker.ts`: does **not** use `resolveCommandEnv`; it exports every env key passed to executor before every command.
- `host.ts`: receives no vault env from resolver and ignores env.

This means current behavior conflicts with requested target `(1)`: unknown env keys do **not** always inject in container/cloudflare; known keys inject only for matching CLI. Firecracker always injects everything.

## Architecture

Credential flow:

1. Chat `/login` or `/pi-login` creates an expiring link token elsewhere and serves `/link?token=...` through `src/web/login/portal.ts`.
2. The portal renders presets/manual fields from hard-coded `SECRET_PRESETS` and sends `POST /api/link/complete` with `env: Record<string,string>`.
3. `handleLinkComplete()` validates key syntax/value non-empty, consumes link token, and persists env into `vaults/<vaultId>/env` via `VaultManager.upsertEnv()`.
4. Runtime execution resolves the same vault key (`resolveActorVaultKey`) in `ActorExecutionResolver.resolve()` and passes all vault env to non-host executors.
5. Executors decide which env reaches commands.

For target behavior:

- A key registry should probably live near `src/sandbox/credential-policy.ts` or a new module-local `types.ts`/policy module, because sandbox injection needs to distinguish known keys per CLI from unknown keys.
- `/pi-login` UI/API exposure modes need data persisted with env keys or in a sidecar because vault currently stores only values. Without metadata, server cannot know whether a stored known key should be exposed to All commands / Selected CLIs / Never after a restart.
- Backward compatibility decision needed for existing flat `vaults/*/env`: likely treat existing known keys as Selected CLIs and unknown keys as All commands, matching current intent plus requested unknown-always-inject.

## Start Here

Start with `src/sandbox/credential-policy.ts`. It is the central policy hook for container/cloudflare command env injection and already contains the known CLI key map. Then inspect `src/web/login/portal.ts` to add UI/API exposure-mode collection and persistence, and `src/vault/index.ts`/`src/vault/types.ts` for metadata storage shape.

## Constraints, Risks, Open Questions

- Project rule: exported types belong in nearest `types.ts`; if adding policy/exposure types under `src/sandbox` or `src/vault`, place them in module `types.ts`.
- Do not log secret values; current logs only env key names.
- `upsertEnv()` raw dotenv writing is not escaping newlines/`=` specially; existing behavior accepts values after first `=` when parsing but writes raw value.
- API currently trusts any valid env key. If UI policy modes must be enforceable, server-side `LinkCompleteBody` needs policy fields, validation, and defaults; do not rely on client JS only.
- Firecracker has divergent behavior (all env always). Aligning it to new policy may be a behavior change and needs tests.
- Tests to update/add: `test/sandbox.test.ts` for known-vs-unknown injection in container/cloudflare/firecracker; `test/vault.test.ts` for any metadata persistence/backcompat; login portal API tests are currently absent, so may need new tests or exported helpers if policy validation is added.
