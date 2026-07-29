# Office isolation verification

The office architecture uses layered tests rather than treating a mount-list unit test as proof of isolation.

## Test layers

1. `src/test/workspace-projection.test.ts` verifies canonical/legacy policy resolution, prompt-source authorization, source materialization, wrong types, symlinks, and malformed-settings fail-closed behavior.
2. `src/test/execution-resolver.test.ts` verifies image/Gondolin plan consumption, mount collision checks, and rejection of backends that cannot provide a persistent isolated office.
3. Agent runner tests verify host-side prompt loading does not follow conversation memory or skill symlinks.
4. `npm run test:office:docker` performs an adversarial test against a real Docker daemon and kernel mount namespace.

## Docker environment

Requirements:

- reachable Docker daemon;
- `alpine:3.21` already pulled locally (the script inspects the image, it never
  pulls), or set `MIKAN_OFFICE_TEST_IMAGE` to another local image containing `sh`;
- outbound HTTPS for the network assertion.

The script creates two temporary host offices but mounts only office A. It verifies:

- office B and shared roots are invisible;
- office A writes survive container teardown and a fresh container run;
- absolute and sibling-relative symlinks cannot reveal unmounted host data;
- outbound network remains available;
- all temporary host data is removed in `finally`.

Run from the repo root — the script (`scripts/verify-office-docker.mjs`) creates
its temporary offices under `.workspace/` in the current directory:

```bash
npm run test:office:docker
```

This is intentionally separate from `npm test`: unit CI environments do not always provide Docker. A release or deployment pipeline that claims isolated `image:*` support should run both commands.

## Future backend gates

Gondolin needs the same behavioral contract in a QEMU-capable integration environment. Factory-floor adapters require a different contract: disposable input packaging, explicit result return, and teardown—not persistent office tests.
