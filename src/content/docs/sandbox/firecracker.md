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
- vault selection logic:
  1. use the conversation ID directly as the vault key, for example `d123`
  2. if no vault is found, env is not injected

Limitations:

- you manage the VM lifecycle
- you manage the workspace mount
- vault file credentials are saved, but are not automatically projected to the target path inside the VM yet
