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
- vault selection normalizes the conversation ID to lowercase with non-alphanumeric runs replaced by `-`; if no matching vault exists, env is not injected

Startup validation requires `fc-agent` or `firecracker` in the host `PATH` and verifies the configured host path. VM status verification is best-effort and may produce only a warning.

Limitations:

- SSH uses `StrictHostKeyChecking=no`; protect the VM network because first-connection host identity is not verified
- you manage the VM lifecycle
- you manage the workspace mount
- vault file credentials are saved, but are not automatically projected to the target path inside the VM yet
