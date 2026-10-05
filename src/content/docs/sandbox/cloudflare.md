---
title: Cloudflare sandbox
description: Run the under-construction Cloudflare sandbox through a self-deployed Cloudflare Worker bridge.
---

:::caution[Under construction]
The Cloudflare mode is present in mikan's sandbox configuration but is not a finished deployment
target: it has no managed workspace projection, no file-credential projection, and no lifecycle or
resource management. It cannot enforce a private office's visibility, so it runs private offices
with a one-time logged warning. It is expected to return later as an outsourced
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

- mikan cannot enforce a private office's visibility here; each private office is run with a
  one-time logged warning
- remote `/workspace` does not automatically mirror the local working directory
- therefore `pwd` shows `/workspace`, but `ls` may be empty; this is expected and does not mean it is
  reading your local repo
- file credentials are refused rather than skipped: if the conversation's vault holds any file besides `env`, the run fails with `Sandbox type "cloudflare" does not support vault file mounts`. Keep credentials in `env` here.
- container lifecycle, idle stop, resource limits, and `/pi-sandbox boost` do not apply
- you must deploy the bridge Worker and corresponding container image yourself

You can use the example bridge directly:

- [Cloudflare sandbox bridge example on GitHub](https://github.com/geminixiang/mikan/tree/main/deploy/examples/cloudflare-sandbox-bridge)
