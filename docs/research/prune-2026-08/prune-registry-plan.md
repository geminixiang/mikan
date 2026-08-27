# Office registry → GitHub adapter reverse dependency plan

## Why implementation was skipped

`src/office/registry.ts` imports `parseGithubConversationId` only for boot-time legacy-directory auto-claiming. A legacy directory is named solely by the raw conversation id and has no stored `OfficeAddress` or platform field yet. The registry therefore must infer which enabled platform could have produced that id before it can create the migration record.

Removing GitHub-id parsing without another source of platform evidence would change migration semantics: existing unclaimed `GH_<owner>_<repo>_<number>` directories would stop auto-claiming as GitHub and become `needs-owner`. Storing `OfficeAddress` in current registry records does not solve this cold-start case because those records do not exist until after the legacy directory has been claimed.

Copying the GitHub regex into `office/registry.ts` would cut the import but create two authorities for the same identity grammar, which is worse than the current dependency direction.

## Proposed seam

Make legacy-id classification an explicit boot composition dependency rather than knowledge owned by `OfficeRegistry`:

1. Define a platform-neutral `LegacyConversationIdMatcher` type near office migration types: platform plus `matches(rawConversationId): boolean`.
2. Pass matchers into the boot-time migration entry point / `OfficeRegistry.prepareLegacyMigration`; the office module remains responsible for ambiguity handling, enabled-platform filtering, journaling, and fail-closed behavior.
3. Each platform supplies its matcher from its own identity authority. GitHub reuses `parseGithubConversationId` or an exported predicate from `adapters/github/ids.ts`; Slack/Discord/Telegram likewise move their current regexes out of registry into platform composition.
4. Preserve the existing rule exactly: auto-claim only when exactly one enabled platform matcher accepts the raw id; otherwise require an explicit owner.
5. Add regression tests covering GitHub ids, Slack ids, negative Telegram ids, Telegram/Discord numeric ambiguity, no matches, and explicitly claimed owners.

## Expected scope

This touches boot composition, office migration options/types, registry construction/callers, and migration tests. Because it changes the identity-classification seam and can affect legacy migration, it should be done as a dedicated change rather than folded into the current pruning patch.
