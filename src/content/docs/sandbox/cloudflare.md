---
title: Cloudflare sandbox
description: Run the under-construction Cloudflare sandbox through a self-deployed Cloudflare Worker bridge.
---

:::caution[Under construction]
The Cloudflare mode is present in mikan's sandbox configuration but is not a finished deployment
target: it has no managed workspace projection, no file-credential projection, and no lifecycle or
resource management. Because it cannot enforce isolated projections or read-only shared memory, it
requires an explicit trusted read-write policy. It is expected to return later as an outsourced
execution surface. Use [`image:<image>`](/sandbox/image/) for
anything real.
:::

```bash
export CLOUDFLARE_SANDBOX_URL="https://your-bridge.workers.dev"
export CLOUDFLARE_SANDBOX_TOKEN="replace-me" # optional

mikan --sandbox=cloudflare:mikan-remote /path/to/workspace
```

Features:

- runtime commands use `/workspace`
- mikan derives the remote sandbox id as `<base-sandbox-id>-<resource-key>`, so each conversation
  addresses its own sandbox on the bridge
- vault env is injected through the bridge on every `exec()`
- credentials are keyed by office key, the same conversation-scoped vault key `image:*` uses

Limitations:

- mikan cannot enforce isolated workspace projection or read-only shared memory here, so an explicit
  trusted read-write policy has to be chosen
- remote `/workspace` does not automatically mirror the local working directory
- therefore `pwd` shows `/workspace`, but `ls` may be empty; this is expected and does not mean it is
  reading your local repo
- file credentials are refused rather than skipped: if the conversation's vault holds any file besides `env`, the run fails with `Sandbox type "cloudflare" does not support vault file mounts`. Keep credentials in `env` here.
- container lifecycle, idle stop, resource limits, and `/pi-sandbox boost` do not apply
- you must deploy the bridge Worker and corresponding container image yourself

You can use the example bridge directly:

- [Cloudflare sandbox bridge example on GitHub](https://github.com/geminixiang/mikan/tree/main/deploy/examples/cloudflare-sandbox-bridge)
