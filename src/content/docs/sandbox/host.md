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
- `/login` can still store credentials in `state-dir/vaults`

Suitable for:

- local development
- cases where you do not want mikan to put vault credentials into host command processes
