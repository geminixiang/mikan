---
title: Firecracker sandbox
description: Execute commands and inject vault env by SSHing into a self-managed Firecracker VM.
---

```bash
mikan --sandbox=firecracker:192.168.1.100:/home/mikan/workspace /home/mikan/workspace
```

Full format:

```text
firecracker:<vm-id>:<host-path>[:<ssh-user>[:<ssh-port>]]
```

Example:

```bash
mikan --sandbox=firecracker:192.168.1.100:/home/mikan/workspace:root:22 /home/mikan/workspace
```

Features:

- mikan runs commands in the VM through SSH
- the workspace inside the VM is expected at `/workspace`
- vault env is injected through SSH stdin so secrets do not appear on the host command line
- credentials are keyed by office key, the same conversation-scoped vault key `image:*` uses; if no matching vault exists, env is not injected

Startup validation requires `fc-agent` or `firecracker` in the host `PATH` and verifies the configured host path. VM status verification is best-effort and may produce only a warning.

Limitations:

- mikan cannot enforce a workspace projection in a VM it does not manage, so the mode refuses to run under the default `isolated` door policy; a trusted policy has to be chosen explicitly
- SSH uses `StrictHostKeyChecking=no`; protect the VM network because first-connection host identity is not verified
- you manage the VM lifecycle
- you manage the workspace mount
- file credentials are refused rather than skipped: if the conversation's vault holds any file besides `env`, the run fails with `Sandbox type "firecracker" does not support vault file mounts`. Keep credentials in `env` here.
- resource limits, idle stop, and `/pi-sandbox boost` do not apply
