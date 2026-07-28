---
status: accepted
---

# Office Address is the future canonical conversation identity

A conversation office is identified internally by its platform and raw platform
conversation ID. `src/office-address.ts` derives a versioned, filesystem-safe
`OfficeKey` from both values; the readable part is diagnostic only and the
SHA-256 digest is the collision-resistant identity component.

The first implementation adds the address module and a host-only registry for
legacy raw-ID migration. It does **not** switch runtime, session, workspace,
vault, package, event, or Admin consumers. Legacy migration remains incomplete
until those consumers are changed together and their upgrade paths are tested.

Platform adapters continue to use raw IDs at their external I/O boundaries.
The registry never infers a platform from an ID prefix: one enabled platform may
claim an unowned legacy directory, while multiple enabled platforms require an
explicit owner.
