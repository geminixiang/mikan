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
- `/pi-login` can still store credentials in `~/.mikan/vaults`, keyed by platform user; env entries simply go unused, but a _file_ credential in that vault fails the run with `Sandbox type "host" does not support vault file mounts`
- bash commands start in the mikan process's own working directory

## Private offices are not enforced

`host` cannot enforce a private office's visibility (ADR 0008): there is nothing to mount into, and
the tools see whatever the host user can see, including other private offices and the shared
`MEMORY.md` and `skills/`. mikan still runs those conversations, and logs once per office:

```text
Sandbox 'host' cannot enforce private office visibility for <office-key>
```

Platform derivation makes this apply to DMs, Slack private channels, externally shared and unknown
conversations, and every Telegram, Discord, and GitHub conversation. The `/pi-sandbox` chat command
is not available in host mode — it only serves the managed `image:*` sandboxes.

Suitable for:

- local development on a machine you already trust with the whole workspace
- cases where you do not want mikan to put vault credentials into host command processes

Not suitable for shared or multi-tenant deployments: host mode gives every conversation the same
filesystem and process view as mikan itself. Use [`image:<image>`](/sandbox/image/) there instead.
