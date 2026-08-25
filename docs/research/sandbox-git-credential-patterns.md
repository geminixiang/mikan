# How production agent platforms give a sandboxed agent `git push`

Primary-source survey (2026-08-17) of the mechanisms real platforms use to let a
sandboxed agent push code and call provider APIs without long-lived user
credentials living inside the sandbox. Companion to
[`connector-platform-selection.md`](./connector-platform-selection.md); the
conclusions drive where mikan's connector gateway, vault projection, and the
GitHub adapter each sit.

## The four patterns, ranked by industry convergence

### (b) Boundary proxy holding the real credential — the frontier consensus

Four independent implementations converged on the same shape — the guest holds
a worthless placeholder, an egress proxy swaps in the real value per allowlisted
host:

- **Claude Code on the web**: "Sensitive credentials … are never inside the
  sandbox"; the git client authenticates to a proxy with a scoped credential,
  and the proxy "verifies … the contents of the git interaction (e.g. ensuring
  it is only pushing to the configured branch), then attaches the right
  authentication token" — the proxy is a _policy point_, not just a secret
  swap. (anthropic.com/engineering/claude-code-sandboxing)
- **Claude Code local sandbox**: literal sentinel + TLS-terminating proxy;
  substitution in headers _and_ bodies; sentinel file copies with `extract`
  regex (their worked example is a GitHub `oauth_token`); fail-closed when TLS
  termination is off; mask config honored only from user/managed settings,
  never repo-local. (code.claude.com/docs/en/sandboxing)
- **Docker Sandboxes**: guest sees `proxy-managed`; "the real credential stays
  on the host"; GitHub onboarding is `gh auth token | sbx secret set github`;
  ships SSH agent forwarding for the same reason.
  (docs.docker.com/ai/sandboxes/security/credentials)
- **Daytona Secrets**: `dtn_secret_*` placeholder, proxy substitutes on
  outbound HTTPS headers (headers only — no body substitution), and scrubs the
  real value out of _responses_. (daytona.io/docs/en/secrets)

### (a) Ephemeral scoped App installation token per unit of work — the incumbent

**GitHub Actions `GITHUB_TOKEN`** is the reference: before each job, GitHub's
control plane mints a GitHub App installation access token scoped to the one
repository with per-job declared permissions; it expires when the job ends.
The token _is_ inside the runner — the guarantee is bounded blast radius, not
absence. App installation tokens generally: 1h, repo-list and permission-subset
selectable at mint time, minted from an App private key that never leaves the
host. Codex cloud is widely reported (not primary-verified) to use the same
mechanism; what its docs do verify is that configured secrets "are removed
before the agent phase starts".

### (c) Long-lived user token in the guest — the "dangerously" tier

Still common in the infra-primitive tier (E2B, Modal, Daytona's SDK git module,
NVIDIA OpenShell), but nobody defends it: E2B literally names the API
`dangerouslyAuthenticate()` and warns "any process or agent with access to the
sandbox can read them". This is what a vault-projected `GH_TOKEN` is.

### (d) Credential helper RPC out of the guest — precedented parts, unnamed whole

git's credential-helper contract allows a helper that implements only `get`
(nothing persisted, fresh credential per operation — `gh auth git-credential`,
`gcloud auth git-helper` work this way). No vendor documents the full shape
"guest helper → unix/vsock socket → host minter", but every piece ships: SSH
agent forwarding is exactly this shape, and Claude Code's sandbox-runtime
already bind-mounts host unix sockets into the sandbox as its network
transport. Weaker than (b) — the real token transits guest memory for seconds —
but no TLS MITM, no CA, works with cert pinning.

## GitHub credential facts that constrain any design

| Credential              | Lifetime                                  | Repo scoping          | Permissions                             |
| ----------------------- | ----------------------------------------- | --------------------- | --------------------------------------- |
| App installation token  | 1h, re-mint                               | Yes (list at mint)    | Subset at mint                          |
| OAuth user access token | Long-lived (opt-in 8h + rotating refresh) | **No — account-wide** | Coarse scopes; `repo` is all-or-nothing |
| Fine-grained PAT        | Configurable                              | Per-repo              | Fine-grained                            |

**OAuth user tokens cannot be repo-scoped** (verified against GitHub's
OAuth-vs-Apps comparison). Any design that hands a personal OAuth token to a
guest hands over the user's entire account reach for the token's lifetime —
shortening the lifetime (mint-on-inject schemes) narrows the window but never
the blast radius. That is why this survey killed mikan's "①.5 short-lived
mint + inject" proposal.

## Where mikan already stands

Mikan independently implements the two winning patterns:

- **GitHub adapter = (a) plus the policy point from (b)**: the conversation
  clone is bind-mounted into the sandbox _credential-less_ (nothing
  credential-shaped may land in `.git/config` — `src/adapters/github/repo.ts`);
  the agent commits freely with in-guest git; push is a host-side tool
  (`github_pr`) using a per-invocation single-repo permission-subset
  installation token, with the `pi/*` branch policy enforced host-side. This is
  the same division Claude Code on the web uses: guest does git, boundary does
  auth + authorization.
- **Connector gateway = host action layer**: provider OAuth tokens live in the
  connector and are never exportable; the guest sees tool results only.
- **Gondolin sentinel route = (b)**, independently validated by the 15-repo
  sandbox survey (issue #88): boundary substitution converged 4× there too.

The one legacy exception is vault-projected personal tokens (`GH_TOKEN`,
`gws.json`) — pattern (c). They stay as an explicit, documented opt-in escape
hatch for guest CLIs, to be displaced over time by host-side tools (personal
push tool, connector actions) and eventually by the Gondolin sentinel proxy —
not by minting shorter-lived copies of the same guest-held credential.
