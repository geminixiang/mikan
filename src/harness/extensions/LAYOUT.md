# State-dir layout: conversation-scoped extension code + data

Status: **shipped.** The scope segment is now the office key, not the raw
conversation id — see "Migrations" for both moves that got us here.

## Principle

A conversation is the unit of encapsulation. Everything host-only that
belongs to one conversation — its settings, the extensions installed only
for it, and those extensions' per-conversation data — lives under that one
office directory. `global/` is the symmetric sibling scope for things that
span all conversations.

Path shape, everywhere:

```
<scope>/…            where <scope> is  conversations/<office key>   or   global
```

`officeStateDir(stateDir, address)` is the one helper that builds the
conversation arm; nothing composes that path by hand.

## Layout

```
~/.mikan/
├── settings.json                      # machine-wide config singletons
├── models.json
├── office-registry.json               # raw id ↔ office key journal (keys are not reversible)
│
├── conversations/
│   └── <office key>/                  # ALL host-only assets of one conversation
│       ├── settings.json              # conversation settings
│       ├── extensions/<slug>/         # extension code installed for THIS conversation
│       ├── extension-data/<slug>/     # that extension's data for THIS conversation
│       └── git/<host>/<owner>/<repo>/ # packages declared for THIS conversation
│
├── global/                            # the "all conversations" scope (sibling of one office)
│   ├── extensions/<slug>/             # extension code installed for ALL conversations
│   ├── extension-data/<slug>/         # extension data shared across conversations
│   └── git/<host>/<owner>/<repo>/     # packages declared for ALL conversations
│
└── vaults/                            # credentials — self-contained
    ├── <office key>/                  # one conversation's credentials
    ├── <userId>/
    ├── shared/<name>/
    └── extensions/<slug>/             # extension secrets (host-only)
```

`conversations/<office key>/` and `global/` are **isomorphic**: both hold
`extensions/` (code), `extension-data/` (data), and `git/` (packages). The
only difference is the partition key — one conversation vs. all of them.

### code vs data stay separate (a hard requirement)

Within each scope, `extensions/` and `extension-data/` are **sibling
directories, never merged**:

- `extensions/` is the loader's scan surface — any `.mjs`/`.js` placed there
  is imported as an extension. Mixing state in would get loaded as code.
- Installing an extension is a directory replace (`cp -r` / `rm -rf`); data
  living inside the code dir would be wiped on upgrade.

So "code and data both live under the conversation" means both sit _inside_
`conversations/<office key>/`, as two adjacent subdirectories — not one
directory.

### Deleting a conversation

`rm -rf conversations/<office key>/` removes its settings, its
conversation-scoped extension code, and that code's per-conversation data
together — correct by construction. Global assets are untouched. Find the
key for a raw id with `mikan office list`, or read `office-registry.json`;
the key's digest is one-way, so you cannot derive the id back from the path.

## API mapping

| API / concept                     | Path                                                |
| --------------------------------- | --------------------------------------------------- |
| extension code (global install)   | `global/extensions/<slug>/`                         |
| extension code (per conversation) | `conversations/<office key>/extensions/<slug>/`     |
| `api.paths.dataDir`               | `conversations/<office key>/extension-data/<slug>/` |
| `api.paths.sharedDataDir`         | `global/extension-data/<slug>/`                     |
| conversation settings             | `conversations/<office key>/settings.json`          |

`api.paths.dataDir` remains the safe, per-conversation default;
`sharedDataDir` remains the explicit cross-conversation opt-in. Only the
underlying paths moved — the API surface and the "isolation is the default"
semantics are unchanged.

## `global` vs `shared`

This layout uses **`global`** for the all-conversations scope. Vaults keep
their existing `vaults/shared/<name>/` — self-contained, and not worth
churning a live credential store over. Two words coexist by deliberate
scoping: `global` for the conversations/extensions axis, `shared` inside
vaults.

## Casing

**Path segments are lowercase by construction; no id is ever transformed on
its way to a path.**

- The conversation segment is an office key
  (`v1-<platform>-<readable>-<16 hex>`), which `officeKey()` builds already
  lowercased. The readable middle is a hint; the SHA-256 digest is the
  identity authority, so two spellings of an id cannot produce two
  directories.
- Extension slugs are lowercased in `extensionSlug()` (they are derived from
  install dir/file names, not identifiers), so `extensions/agent-pm/`.

Rationale: a mix of upper- and lowercase spellings of the same id is two
directories on Linux but one on case-insensitive filesystems (macOS dev, some
Docker volumes) — a dev/prod split that is invisible until it corrupts state.
Deriving the segment once, lowercased, removes the class of bug entirely.
This is also why raw platform ids stop at I/O boundaries: uppercase Slack ids
never reach a path.

## Migrations

Two moves brought the state dir to this shape; both are historical and run
automatically.

Scope reshuffle (from the beta.4 layout):

```
extensions/global/<slug>/                  →  global/extensions/<slug>/
extensions/<id>/<slug>/                    →  conversations/<id>/extensions/<slug>/
extension-data/<slug>/shared/              →  global/extension-data/<slug>/
extension-data/<slug>/conversations/<id>/  →  conversations/<id>/extension-data/<slug>/
```

Office keying (ADR 0005) then renamed the conversation segment:

```
conversations/<raw conversation id>/  →  conversations/<office key>/
vaults/<legacy conversation key>/     →  vaults/<office key>/
```

The office migration runs every boot, journaled prepare → moving → committed
with crash recovery (`src/office/migration.ts`). A directory it cannot assign
an owner for fails boot until `mikan office claim <id> <platform>` names one.

## Code touchpoints

- `defaultExtensionDirs(address, stateDir)` → `[global/extensions, officeStateDir(stateDir, address) + "/extensions"]`.
- loader `paths.dataDir` / `paths.sharedDataDir` getters → the two paths in the API table.
- `extensionSlug()` is derived from the install dir/file name, independent of scope.
- `commands/extensions.ts` reads the scope label from the parent segment of
  the scan dir (`basename(dirname(info.dir))`), since dirs end in
  `<scope>/extensions`.
