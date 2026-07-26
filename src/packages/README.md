# src/packages

Turns a human-written package source string into files on the mikan host, and
decides when two sources are the same package.

A package is one git repository (or host directory) that ships extensions
and/or skills. Packages are how extensions reach a mikan deployment whose users
have no shell on the host: someone pastes a source into the admin portal, mikan
materializes it into the host-only state dir, and the next harness instance
loads it.

## Files

- `source.ts`: The grammar. `parseSource` maps `<locator>[@<ref>][#<subpath>]` to a tagged `ParsedSource`; `sourceIdentity` decides package sameness for deduplication and scope precedence; `gitRepoPath` derives the transport-independent `<host>/<path>` used by the clone layout; `formatSource` renders the canonical string written back into settings.
- `materialize.ts`: The side effects. `materializeSource` clones or reconciles a git package under the scope's host-only git directory and returns the directory holding its files; its `offline` / `fetch` / `refresh` mode decides how far it may go to get them. `packageScopeDir` resolves the `global` / `conversations/<id>` root; `gitCloneDir` exposes the ref-keyed checkout location.
- `resolve.ts`: What a conversation loads. `resolveConversationPackages` combines both scopes, resolves same-package collisions in the conversation's favour, and reports extension directories, extension roots, and skill directories. `conversationPackageSkillMounts` turns the skill directories into read-only sandbox mounts; `packageSkillRuntimeDir` is the single definition of where they appear inside the guest.
- `inspect.ts`: The administrator's view. `inspectConversationPackages` reports every declared source per scope — including ones that failed to materialize or are shadowed by a narrower scope — with the extensions and skills each contributes.
- `admin.ts`: The write path behind the portal. `addPackage` / `removePackage` / `refreshPackage` materialize before persisting, so failures land in front of whoever typed the source.
- `types.ts`: `ParsedSource`, `PackageIdentity`, `MaterializedPackage`, and the scope vocabulary.

## Scopes

`global` packages load for every conversation; a conversation's packages load
on top. The lists are **additive**, not overriding — but when both scopes
declare the same package (`sourceIdentity`, which ignores the ref), only the
conversation's copy loads. That is how one channel pins v2 while everyone else
stays on v1, and it is why a package declared twice cannot activate twice.

Deduplication happens before any module is imported, because the slug keys an
extension's data dir, secrets, and schedules: two live copies would fight over
the same state.

## Package layouts

A package contributes extensions in one of two shapes, chosen by its own
layout rather than by configuration:

- an `extensions/` subdirectory, scanned for named children (several extensions
  in one repo), and/or
- the package root itself being a loadable extension (a one-extension repo, and
  what a developer's working copy looks like).

Skills live in `skills/` and are mounted read-only at
`/mikan/packages/<slug>/skills`, outside `/workspace` so `full` workspace-mount
mode cannot shadow them. Unlike extension-shipped skills they are not inlined
into the prompt, so a skill may ship scripts and templates beside its
`SKILL.md`.

## Why only git

npm is deliberately unimplemented. The two seams that make it a local change
later are already in place: `parseSource` returns a tagged union, and
`sourceIdentity` is a single function. Adding `npm:` means one arm in each plus
a materializer that installs into `<scope>/npm/` — nothing downstream
(resolution, scope precedence, the portal) learns a new source type.

The seam that would have made this expensive is identity. If dedup keyed off
git URLs directly instead of an opaque `PackageIdentity`, every call site would
need to grow an npm branch.

## Refs and updates

`@<ref>` is a tag, branch, or commit sha; absent means the remote's default
branch. Every kind is fetched the same way (`git fetch --depth 1 origin <ref>`
then checkout `FETCH_HEAD`), so there is no per-ref-kind branching.

A materialized package is never re-fetched implicitly. `mode: "refresh"` is the
explicit update, which resets and cleans the clone before moving it — so a
pinned ref stays put until a human edits it, and an unpinned one advances only
when a human asks. A conversation load uses `mode: "offline"` and so can never
block a reply on a remote.

Checkout paths are keyed by the effective ref: the old
`<scope>/git/<host>/<owner>/<repo>` path remains the checkout for an unpinned
source (and `@HEAD`), while an explicit ref uses a sibling named with a
SHA-256 ref key. Thus subpaths at one ref share files, but different refs
cannot reset one another. On first use of a keyed path, a legacy checkout with
a matching `mikan-ref` marker is copied locally; markerless or mismatched
legacy checkouts are rebuilt by `fetch`/`refresh`, and `offline` only accepts a
completed matching checkout. The `mikan-ref` marker is written only after
subpath validation and `npm install` succeed, so a failed install is retried
rather than mistaken for a ready checkout.

Refs containing a slash (`release/1.0`) cannot be written in the string form,
because `@` is ambiguous with the authority in `git@host:owner/repo`. Pin to a
tag or a sha. The portal takes URL and ref as separate inputs and assembles the
canonical string, so this only constrains hand-edited settings.

## Trust

Materialized code is imported into the mikan process with its full privileges
(vault, platform tokens, host filesystem), and `npm install` runs the
dependencies' install scripts. Everything therefore lands under the host-only
state dir and never the workspace — a mounted location would let sandboxed
code write what the host executes. See `src/sandbox/README.md`.
