---
status: accepted
---

# Office Address is the future canonical conversation identity

A conversation office is identified internally by its platform and raw platform
conversation ID. `src/office-address.ts` derives a versioned, filesystem-safe
`OfficeKey` from both values; the readable part is diagnostic only and the
SHA-256 digest is the collision-resistant identity component.

The normalized conversation event/message seam now carries `OfficeAddress`, and every production platform or synthetic intake validates the compatibility raw ID against it. Runtime/session maps, filesystem, settings, vault, package, event ownership, and Admin scope still use legacy raw IDs until their coordinated migration commits land.

Platform adapters continue to use raw IDs at their external I/O boundaries.
The registry never infers a platform from an ID prefix: one enabled platform may
claim an unowned legacy directory, while multiple enabled platforms require an
explicit owner.
