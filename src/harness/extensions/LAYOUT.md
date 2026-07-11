# State-dir layout: conversation-scoped extension code + data

Status: **implemented** (main, targeting the next beta). Prod on
1.0.0-beta.4 still uses the older `extensions/global` + `extension-data/<slug>`
layout — see "Migration" for the one-time move.

## Principle

A conversation is the unit of encapsulation. Everything host-only that
belongs to one conversation — its settings, the extensions installed only
for it, and those extensions' per-conversation data — lives under that one
conversation directory. `global/` is the symmetric sibling scope for things
that span all conversations.

Path shape, everywhere:

```
<scope>/…            where <scope> is  conversations/<id>   or   global
```

## Layout

```
~/.mikan/
├── settings.json                     # machine-wide config singletons
├── models.json
│
├── conversations/
│   └── <conversationId>/             # ALL host-only assets of one conversation
│       ├── settings.json             # conversation settings
│       ├── extensions/<slug>/        # extension code installed for THIS conversation
│       └── extension-data/<slug>/    # that extension's data for THIS conversation
│
├── global/                           # the "all conversations" scope (sibling of one <id>)
│   ├── extensions/<slug>/            # extension code installed for ALL conversations
│   └── extension-data/<slug>/        # extension data shared across conversations
│
└── vaults/                           # credentials — unchanged, self-contained
    ├── <userId>/
    └── shared/<name>/
```

`conversations/<id>/` and `global/` are **isomorphic**: both hold
`extensions/` (code) and `extension-data/` (data). The only difference is the
partition key — one conversation vs. all of them.

### code vs data stay separate (a hard requirement)

Within each scope, `extensions/` and `extension-data/` are **sibling
directories, never merged**:

- `extensions/` is the loader's scan surface — any `.mjs`/`.js` placed there
  is imported as an extension. Mixing state in would get loaded as code.
- Installing an extension is a directory replace (`cp -r` / `rm -rf`); data
  living inside the code dir would be wiped on upgrade.

So "code and data both live under the conversation" means both sit _inside_
`conversations/<id>/`, as two adjacent subdirectories — not one directory.

### Deleting a conversation

`rm -rf conversations/<id>/` removes its settings, its conversation-scoped
extension code, and that code's per-conversation data together — correct by
construction. Global assets are untouched.

## API mapping

| API / concept                     | Path                                              |
| --------------------------------- | ------------------------------------------------- |
| extension code (global install)   | `global/extensions/<slug>/`                       |
| extension code (per conversation) | `conversations/<id>/extensions/<slug>/`           |
| `api.paths.dataDir`               | `conversations/<id>/extension-data/<slug>/`       |
| `api.paths.sharedDataDir`         | `global/extension-data/<slug>/`                   |
| conversation settings             | `conversations/<id>/settings.json` (already here) |

`api.paths.dataDir` remains the safe, per-conversation default;
`sharedDataDir` remains the explicit cross-conversation opt-in. Only the
underlying paths move — the API surface and the "isolation is the default"
semantics are unchanged.

## `global` vs `shared`

This line uses **`global`** for the all-conversations scope. Vaults keep
their existing `vaults/shared/<name>/` (self-contained, 274 live dirs in
prod — not worth churning). Two words coexist by deliberate scoping:
`global` for the conversations/extensions axis, `shared` inside vaults.
(Open question for 1.0: unify vaults onto `global` too, or leave as-is.)

## Casing

**id-keyed path segments are verbatim; derived slugs are lowercased.**

- Conversation ids are used exactly as the platform provides them — Slack
  ids are uppercase (`C…`/`D…`) and stable, so `conversations/C03045VJJAY/`.
  This matches what mikan already writes for the workspace conversation dirs
  and `conversations/<id>/settings.json`, so no conversion happens anywhere
  and prod migration needs no renames.
- Extension slugs are lowercased in `extensionSlug()` (they are derived from
  install dir/file names, not identifiers), so `extensions/agent-pm/`.

Rationale: never transform an id on the way to a path. A mix of upper- and
lowercase spellings of the same id is two directories on Linux (prod) but one
on case-insensitive filesystems (macOS dev, some Docker volumes) — a
dev/prod split that is invisible until it corrupts state. Verbatim ids remove
the class of bug entirely.

**Exception:** `vaults/<key>/` lowercases its key (vault routing calls
`.toLowerCase()`; 274 live dirs depend on it). This is a historical special
case — do not copy it. New id-keyed paths are verbatim.

## Migration (from beta.4 layout)

Old → new, per host:

```
extensions/global/<slug>/            →  global/extensions/<slug>/
extensions/<id>/<slug>/              →  conversations/<id>/extensions/<slug>/
extension-data/<slug>/shared/        →  global/extension-data/<slug>/
extension-data/<slug>/conversations/<id>/  →  conversations/<id>/extension-data/<slug>/
```

`conversations/<id>/settings.json` already lives at the target root, so the
conversation directory just gains `extensions/` and `extension-data/`
subdirectories.

## Code impact (small, single change)

- `defaultExtensionDirs(convId, stateDir)` → `[global/extensions, conversations/<id>/extensions]`.
- loader `paths.dataDir` / `paths.sharedDataDir` getters → the two paths in the API table.
- `extensionSlug()` unchanged (still derived from install dir/file name).
- `commands/extensions.ts` scope label now reads the parent segment of the
  scan dir (`basename(dirname(info.dir))`), since dirs end in `<scope>/extensions`.
