---
title: Host sandbox
description: Run commands directly on the host machine, suitable for local development and cases that should not inject vault env.
---

```bash
mikan --sandbox=host /path/to/workspace
```

Features:

- commands run directly on the host machine
- vault env is not injected
- `/pi-login` can still store credentials in `state-dir/vaults`, keyed by platform user; env entries simply go unused, but a _file_ credential in that vault fails the run with `Sandbox type "host" does not support vault file mounts`
- bash commands start in the mikan process's own working directory

## Door policy requirement

`host` cannot enforce a conversation-scoped workspace projection or read-only shared memory: there
is nothing to mount into, and the tools see whatever the host user can see. mikan therefore refuses
to run when the effective projection is isolated or has private/read-only shared memory. Platform
derivation makes this relevant for DMs, external/unknown conversations, and Slack private channels.
An isolated projection fails with:

```text
Sandbox 'host' cannot provide an isolated conversation office; use image:*,
or explicitly choose trusted workspace policy
```

A private/read-only projection similarly fails with `cannot enforce read-only shared workspace
memory`. To use host mode for those conversations, choose a trusted read-write policy explicitly,
either globally in `<state-dir>/settings.json`:

```json
{
  "sandbox": {
    "workspace": { "doorPolicy": "trusted", "layout": "shared-support" }
  }
}
```

or per conversation from the admin portal. The `/pi-sandbox` chat command is not available in host
mode — it only serves the managed `image:*` sandboxes.

Suitable for:

- local development on a machine you already trust with the whole workspace
- cases where you do not want mikan to put vault credentials into host command processes

Not suitable for shared or multi-tenant deployments: host mode gives every conversation the same
filesystem and process view as mikan itself. Use [`image:<image>`](/sandbox/image/) there instead.
