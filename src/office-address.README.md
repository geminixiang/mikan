# Office address foundation

`office-address.ts` defines the canonical identity for a conversation office:
`platform` plus the platform's raw `conversationId`. The raw identifier stays at
platform I/O boundaries; storage paths use the versioned `OfficeKey` derived by
SHA-256 from both values.

`office-registry.ts` is host-only migration journal storage. It records which
platforms are enabled and the ownership/state of legacy raw-ID directories. It
uses atomic private JSON writes and deliberately records migration transitions
without moving existing workspace or state artifacts. Runtime consumers are
not switched until a later Office Address migration step.
