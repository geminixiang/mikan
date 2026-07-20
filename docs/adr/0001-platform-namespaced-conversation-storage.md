---
status: accepted
---

# Namespace all conversation storage by platform

A platform-issued conversation ID is only a wire address and is not globally unique: Discord and Telegram can issue the same numeric value. Mikan will therefore use a conversation storage scope composed from platform namespace plus wire conversation ID for every conversation-owned file, session, credential, runtime, lease, and placement, while leaving the wire ID unchanged at platform interfaces. The host workspace root supplies the outer Workspace namespace, so it is not duplicated into child paths or disclosed to workers.

Legacy unscoped storage may be claimed only when one platform owner is uniquely established and the claim is durably recorded. Migration must first prevent new legacy use, fence and remove legacy Gondolin runtime authority across every enrolled worker, then atomically publish the scoped storage mapping and migrate the conversation vault before a workspace-bound completion record permits scoped startup. Missing, corrupt, cross-platform, disconnected-worker, vault-conflict, or ambiguous ownership fails closed and requires an explicit operator choice; mikan must never assign historical data or a writable runtime to whichever platform happens to start first.

This deliberately rejects partial schemes that namespace only Gondolin keys while leaving logs, sessions, settings, vaults, or image workspaces shared. Such schemes preserve cross-platform disclosure and create two storage authorities for one conversation. It also preserves `image:*` durability: migration moves or aliases the complete conversation storage unit rather than starting an empty scoped workspace.
