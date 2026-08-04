# mikan Global Architecture Index Schema

Status: **Normative**

Schema version: **1.0**

Instance: [`../../../architecture.toml`](../../../architecture.toml)

This specification defines the exact shape and reference rules of mikan's shallow global architecture index. It specifies the index format, not mikan's architecture content. System semantics belong in `ARCHITECTURE.md` and module-local README files.

Normative **MUST**, **MUST NOT**, **SHOULD**, and **MAY** indicate requirements.

## 1. Goals and exclusions

The index MUST make these facts globally discoverable:

- architecture modules;
- stable seams and their ownership;
- architecture-significant resources and their authority;
- major cross-module flow topology;
- cross-module invariants;
- known deviations from the accepted model.

The index MUST NOT become an implementation inventory. It SHOULD exclude:

- private helpers and local types;
- exhaustive exports or import graphs;
- function-level call traces;
- algorithms and detailed error handling;
- external SDK payload schemas;
- rendering details;
- operational tuning values;
- long rationale already owned by Markdown or an ADR.

## 2. Document and compatibility rules

A conforming document is UTF-8 TOML 1.0 with these exact top-level keys:

```toml
schema_version = "1.0"
system = "mikan"
docs = "ARCHITECTURE.md"

[[modules]]
# ...

[[seams]]
# ...

[[resources]]
# ...

[[flows]]
# ...

[[invariants]]
# ...

[[deviations]]
# ...
```

All three scalar keys and all six arrays of tables are required. Arrays MUST NOT be empty. Unknown top-level keys are invalid.

A consumer MUST reject an unknown `schema_version` major version. A repository conformance check SHOULD require exact version `1.0`.

## 3. Common rules

### 3.1 IDs

Every record requires `id`, matching:

```text
^[a-z0-9]+(?:-[a-z0-9]+)*$
```

IDs MUST be unique within their record kind. IDs are stable references:

- source-file moves and display-name changes MUST NOT force an ID change;
- an ID MUST NOT be reassigned to a different concept;
- a continuous concept SHOULD retain its ID through implementation refactors;
- removal is preferable to keeping a misleading record, but references MUST migrate in the same change.

IDs are type-scoped. A module and resource MAY technically share text, but SHOULD NOT because untyped target fields would become ambiguous.

### 3.2 Paths and anchors

Repository paths use `/` separators and are relative to the repository root.

- `sources` entries MUST name an existing file or directory.
- `docs` and `adr` paths before an optional `#fragment` MUST name an existing Markdown file.
- A `docs` fragment MUST resolve to a generated Markdown heading slug or explicit HTML `id` anchor.
- Paths MUST NOT contain `..`, absolute roots, or URLs.

### 3.3 Exact fields

Each record MUST contain all required fields and MUST NOT contain unknown fields. This is a closed schema. New optional fields require a schema minor version.

All strings MUST be non-empty after trimming. Arrays declared non-empty MUST contain at least one value and MUST NOT contain duplicates.

## 4. Module records

A module has an interface understood across a meaningful seam, owns an architecture authority, fills an established adapter slot, or carries knowledge that must be understood together.

```toml
[[modules]]
id = "office"
name = "Conversation office"
kind = "authority"
docs = "src/office/README.md"
sources = ["src/office/"]
```

Exact required fields:

| Field     | Type                   | Constraint                               |
| --------- | ---------------------- | ---------------------------------------- |
| `id`      | string                 | Common ID grammar                        |
| `name`    | string                 | Human-readable name                      |
| `kind`    | enum                   | Listed below                             |
| `docs`    | string                 | Markdown path with optional fragment     |
| `sources` | non-empty string array | Existing repository files or directories |

`kind` is exactly one of:

- `entrypoint` — process composition or external invocation root;
- `orchestrator` — coordinates a cross-module lifecycle or flow;
- `core` — central domain execution machinery;
- `authority` — single owner of an identity, state, or convention;
- `policy` — resolves security or access policy;
- `registry` — owns an extensible implementation inventory;
- `adapter` — translates an external protocol or platform;
- `infrastructure` — execution, storage, transport, or side facility;
- `extension-host` — hosts trusted extension code and lifecycle.

## 5. Seam records

A seam records a stable caller relationship. It is not synonymous with a TypeScript interface.

```toml
[[seams]]
id = "office-resolution"
owner = "office"
consumers = ["conversation-runtime", "sessions"]
interface = "OfficeAddress and Office"
docs = "src/office/README.md"
```

Exact required fields:

| Field       | Type                   | Constraint                                              |
| ----------- | ---------------------- | ------------------------------------------------------- |
| `id`        | string                 | Common ID grammar                                       |
| `owner`     | string                 | Existing module ID                                      |
| `consumers` | non-empty string array | Existing module IDs; owner MUST NOT appear              |
| `interface` | string                 | Non-empty implementation contract names or entry points |
| `docs`      | string                 | Markdown path with optional fragment                    |

A seam has exactly one owner. Use consumers to show stable dependency direction, not every incidental caller.

## 6. Resource records

A resource is recorded when its ownership, lifecycle scope, or security class matters across modules.

```toml
[[resources]]
id = "office-registry"
authority = "office"
scope = "deployment"
classification = "host-authoritative"
docs = "src/office/README.md"
```

Exact required fields:

| Field            | Type   | Constraint                           |
| ---------------- | ------ | ------------------------------------ |
| `id`             | string | Common ID grammar                    |
| `authority`      | string | Existing module ID                   |
| `scope`          | enum   | Listed below                         |
| `classification` | enum   | Listed below                         |
| `docs`           | string | Markdown path with optional fragment |

`scope` is exactly one of:

- `deployment`;
- `workspace`;
- `conversation`;
- `session`;
- `office-and-session`;
- `conversation-runtime`;
- `credential-key`;
- `conversation-extension`;
- `deployment-and-conversation`.

`classification` is exactly one of:

- `shared-workspace-data`;
- `conversation-data`;
- `host-private`;
- `host-authoritative`;
- `credential`;
- `authorized-view`;
- `ephemeral`;
- `agent-writable-scheduling`;
- `trusted-host-code`.

Each resource has exactly one authority. Authority owns the resource's naming, convention, and lifecycle; it need not be the only reader or writer.

## 7. Flow records

A flow records the topology of a high-value path across modules.

```toml
[[flows]]
id = "conversation-run"
path = ["platform-adapters", "conversation-intake", "conversation-runtime"]
docs = "ARCHITECTURE.md#conversation-run"
```

Exact required fields:

| Field  | Type         | Constraint                                                    |
| ------ | ------------ | ------------------------------------------------------------- |
| `id`   | string       | Common ID grammar                                             |
| `path` | string array | At least two existing module IDs; adjacent duplicates invalid |
| `docs` | string       | Markdown path with optional fragment                          |

A repeated module is valid when the topology leaves and later re-enters it. `path` MUST NOT encode branches or function-level steps; explain those in the linked Markdown.

## 8. Invariant records

An invariant records a cross-module property intended to remain true.

```toml
[[invariants]]
id = "office-address-canonical"
owners = ["office"]
applies_to = ["conversation-runtime", "office-directory"]
docs = "ARCHITECTURE.md#inv-office-address-canonical"
adr = "docs/adr/0005-office-address-identity.md"
```

Exact required fields:

| Field        | Type                   | Constraint                             |
| ------------ | ---------------------- | -------------------------------------- |
| `id`         | string                 | Common ID grammar                      |
| `owners`     | non-empty string array | Existing module IDs                    |
| `applies_to` | non-empty string array | Existing module, seam, or resource IDs |
| `docs`       | yes                    | string                                 | Markdown path with optional fragment              |
| `adr`        | no                     | string                                 | Existing ADR Markdown path with optional fragment |

At least one owner MUST appear in `applies_to` when that owner is itself governed by the invariant. Owners identify the modules responsible for preserving and documenting the rule; they do not imply sole enforcement.

Because `applies_to` accepts three record kinds, target IDs SHOULD be globally unambiguous across modules, seams, and resources.

## 9. Deviation records

A deviation records a current mismatch, limitation, or explicit exception to the accepted architecture.

```toml
[[deviations]]
id = "cloudflare-factory-floor"
status = "open"
affects = ["sandbox", "execution-resolver"]
docs = "ARCHITECTURE.md#dev-cloudflare-factory-floor"
adr = "docs/adr/0002-sandbox-runtime-vs-task-executor.md"
```

Exact fields:

| Field     | Required | Type                   | Constraint                                        |
| --------- | -------- | ---------------------- | ------------------------------------------------- |
| `id`      | yes      | string                 | Common ID grammar                                 |
| `status`  | yes      | enum                   | `open`, `accepted`, or `resolved`                 |
| `affects` | yes      | non-empty string array | Existing module, seam, or resource IDs            |
| `docs`    | yes      | string                 | Markdown path with optional fragment              |
| `adr`     | no       | string                 | Existing ADR Markdown path with optional fragment |

- `open` means the current implementation has not reached the accepted model.
- `accepted` means the exception is intentional and has no planned convergence work.
- `resolved` MAY remain temporarily for traceability and SHOULD be removed in a later cleanup once references have migrated.

A deviation MUST explain observation and disposition in its linked `docs` section. An ADR is required only when the underlying target or exception meets the project's ADR threshold.

## 10. Typed-reference summary

| Source field              | Allowed targets        |
| ------------------------- | ---------------------- |
| `seams.owner`             | module                 |
| `seams.consumers[]`       | module                 |
| `resources.authority`     | module                 |
| `flows.path[]`            | module                 |
| `invariants.owners[]`     | module                 |
| `invariants.applies_to[]` | module, seam, resource |
| `deviations.affects[]`    | module, seam, resource |

All references MUST resolve in the same document. Circular references are valid; architecture topology is not necessarily acyclic.

## 11. Conformance checks

A complete validator MUST reject:

1. invalid TOML;
2. wrong or unknown schema major version;
3. missing or unknown fields;
4. incorrect scalar or array types;
5. empty required strings or arrays;
6. invalid or duplicate IDs;
7. invalid enum values;
8. dangling or wrong-kind references;
9. duplicate entries in arrays that represent sets (`sources`, `consumers`, `owners`, `applies_to`, and `affects`);
10. missing repository paths;
11. unresolved Markdown fragments;
12. flow paths shorter than two modules or containing adjacent duplicates;
13. seam owners repeated as consumers.

A validator SHOULD report the record kind, ID, and field path for every error rather than stopping at the first failure.

## 12. Schema evolution

`schema_version` uses `major.minor`.

Increment the **major** version when a previously valid document can become invalid through:

- removing or redefining a record kind or field;
- changing a field type;
- making an optional field required;
- narrowing an enum;
- changing ID or typed-reference semantics.

Increment the **minor** version when adding a backward-compatible capability:

- a new optional field;
- a new enum value;
- a new optional record kind;
- a new accepted reference target kind.

Clarifying prose without changing the accepted document set does not require a version change.

Update this specification, the `architecture.toml` version, and any conformance tooling in the same change. Do not infer new schema rules solely from one instance record.
