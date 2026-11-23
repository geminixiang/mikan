# Credentials out of the sandbox (2026-11)

The owner asked for credentials to stay out of the sandbox container. Today a vault's values reach the container by design: env is injected into every command and credential files are bind-mounted (ADR 0013). This page records what the current flow is, what a deployment in use stores, which existing projects do this, and lab measurements of two designs. It ends with the choice proposed and the decisions that are the owner's.

## What happens today

- **Write paths.** `/login` in a direct message writes the DM office's vault: env keys from the portal form, files from presets, and OAuth results for GitHub and Google. `/login copy <profile>` and `sandbox.defaultSharedVault` copy a shared profile into an office vault; the default profile is copied into every new office that has no vault yet.
- **Injection.** Env is merged into each command's environment by pi-env (`shellEnv`), not set at container creation. Files are bind mounts set when the container is created; a changed file is detected on the next run and the container is replaced, which removes it.
- **What the model can see.** Everything in the vault: `env` prints the tokens, the mounted files are readable, and gcloud caches access tokens in the home directory. Tool output redaction covers only the daemon's own secrets, so a printed vault value reaches the transcript.
- **Docs drift.** ADR 0013 says `defaultSharedVault` was retired; that commit was reverted and the copy is live.
- **Google files carry the daemon's OAuth client secret.** The `client_secret` of mikan's own OAuth app is written into the user's `gws.json` and gcloud ADC file and so reaches the container.

## What a deployment in use stores

Read-only inventory of one production deployment, names and shapes only:

- Nearly every office vault is a byte-identical copy of one shared profile.
- The profile holds `GH_TOKEN` and `GITHUB_OAUTH_ACCESS_TOKEN`, Sentry auth (`.sentryclirc` and env), and two Google files.
- Both Google files are `authorized_user` credentials (a refresh token), not service-account keys. A refresh token can be exchanged by a proxy, so no real Google token has to exist in the container.
- In the daemon log, the most frequent credential users are `gh`, `gcloud`, and `curl` with an `Authorization` header the agent writes itself, followed by `gws`, `git push/clone`, `gsutil`, and `bq`. A design must cover a header the agent builds itself, not only a known CLI.

## Existing projects

| Project                     | Fit                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| iron-proxy (Apache-2.0, Go) | Placeholder swap in headers including inside Basic; rejects a request whose SNI differs from its Host; body, query, and path swapping off by default; `require_tls` keeps secrets off plain HTTP; an `oauth_token` transform stubs the token endpoint and injects a bearer it mints itself; unread bodies stream; file secret sources reload without restart. Weekly releases, about ten authors, integration tests, signed releases. **One identity per instance.** |
| Infisical Agent Vault       | Multi-tenant by proxy token, but deprecated by its maintainers in favour of their hosted service.                                                                                                                                                                                                                                                                                                                                                                    |
| agentgateway                | Mature general gateway; the swap, per-tenant secrets, and OAuth would be built from CEL and generated config.                                                                                                                                                                                                                                                                                                                                                        |
| nono, matchlock             | Sandboxes with their own proxy; they conflict with one OCI container per office.                                                                                                                                                                                                                                                                                                                                                                                     |
| mitmproxy                   | Mature TLS interception engine; the swap rules are ours to write.                                                                                                                                                                                                                                                                                                                                                                                                    |

## Lab

A recording upstream stands in for GitHub, Google, and Sentry and logs exactly what arrives. Two offices (A, B) run the published sandbox image with `--cap-drop ALL`. Cases are run with real CLIs; no real credential passes through any prototype. Root Docker only; rootless Podman and nerdctl are not yet measured.

### Baseline against a proxy

Baseline is today: real values inside the container. Proxy designs hold placeholders in the container.

| Case                                                                                 | Baseline           | mitmproxy + addon                  | iron-proxy per office                           |
| ------------------------------------------------------------------------------------ | ------------------ | ---------------------------------- | ----------------------------------------------- |
| `gh`, `git` (Basic), `curl` with own header, Node fetch, Python, `sentry-cli`        | work               | work, upstream sees the real value | work, upstream sees the real value              |
| `gcloud auth print-access-token`                                                     | real token printed | placeholder token printed          | stub token printed                              |
| `gsutil`, `gws` calling Google APIs                                                  | fail in the lab    | fail in the lab                    | **authenticate** (the proxy injects the bearer) |
| Token sent to a host it is not bound to                                              | real token leaves  | placeholder                        | placeholder                                     |
| Token written into a request body (a gist)                                           | real token leaves  | placeholder                        | placeholder                                     |
| Token in a URL query                                                                 | real token leaves  | placeholder                        | placeholder                                     |
| Plain HTTP with a forged `Host`                                                      | real token leaves  | not swapped                        | blocked                                         |
| Office B sending office A's placeholder                                              | —                  | not swapped                        | not swapped                                     |
| Real values in env, files, gcloud cache                                              | present            | none                               | none                                            |
| Cloud metadata address                                                               | reachable          | reachable                          | blocked by default                              |
| `pip install`, `npm install`, `apt-get update`, public `git clone`, an ordinary site | work               | work (not intercepted)             | work (intercepted)                              |

### Findings

- **libcurl sends proxy credentials only after a 407.** Attributing requests by proxy credentials needs the proxy to challenge; git otherwise went out unidentified.
- **Bodies must stream.** mitmproxy without `stream_large_bodies` was killed by the kernel while relaying a 955 MB git clone. With streaming, mitmproxy and iron-proxy both relayed it in about 32 s against about 37 s direct; iron-proxy stayed under 30 MB of memory.
- **One iron-proxy per office uses 11–26 MB idle.** Only offices with a running sandbox need one.
- **iron-proxy intercepts all TLS or none.** Every HTTPS connection from the container is decrypted. The common package managers worked; a tool with its own pinned roots would not.
- **Attribution by topology.** A per-office proxy on the office's own network cannot hand A's credentials to B, and needs no source-IP or proxy-password mapping. A single shared proxy would have to join every office network, and a deployment in use already holds a large share of its address pool's networks.

## Proposed

iron-proxy, one per office with a running sandbox, on that office's network; the container's `HTTPS_PROXY` points at it and its CA is trusted. mikan keeps only the glue: starting and stopping the proxy with the container, writing each office's config and secret files from its vault, reloading on rotation, and handing the CA to the container. Our own swap code is not needed.

What stays in the container: credentials that are not HTTP headers (SSH keys, kubeconfig, database passwords) and any env key mikan cannot bind to a host. The proxy protects a credential's value, not its use: the agent can still act with it, it cannot read or send the value elsewhere.

## Decisions for the owner

1. **All container HTTPS is decrypted by the office's proxy.** Behaviour today is unchanged for the tools measured; a tool that pins certificates would fail.
2. **Binding a secret to hosts.** Known keys (GitHub, Sentry, Google files) get a fixed host list in mikan. A key mikan does not know (a custom API token) has no host to bind: keep injecting it into the container as today, or ask for its hosts at `/login`.
3. **Cloud metadata becomes unreachable from the sandbox.** iron-proxy blocks it by default.
4. **Identity in direct messages.** Separate from the proxy: direct-message offices are seeded from the shared profile today, so making a DM the person's identity means stopping that seeding, and those users lose GitHub and Google access until they log in.

## Not yet measured

- Rootless Podman (the Slack E2E lane) and nerdctl.
- Whether a deployment's sandbox can reach cloud metadata today.
- Office networks left behind after their container is removed.
