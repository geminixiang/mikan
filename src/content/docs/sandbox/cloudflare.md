---
title: Cloudflare sandbox
description: Run the experimental Cloudflare sandbox through a self-deployed Cloudflare Worker bridge.
---

```bash
export CLOUDFLARE_SANDBOX_URL="https://your-bridge.workers.dev"
export CLOUDFLARE_SANDBOX_TOKEN="replace-me" # optional

mikan --sandbox=cloudflare:mikan-remote /path/to/workspace
```

Features:

- runtime commands use `/workspace` by default; override it with `CLOUDFLARE_SANDBOX_CWD`
- mikan derives the remote sandbox id as `<base-sandbox-id>-<vault-key>`
- vault env is injected through the bridge on every `exec()`
- vault selection logic is similar to `image`: a platform-scoped vault key is generated from the conversation ID

Limitations:

- remote `/workspace` does not automatically mirror the local working directory
- therefore `pwd` shows `/workspace`, but `ls` may be empty; this is expected and does not mean it is reading your local repo
- vault file credentials are not automatically projected to the Cloudflare sandbox yet
- you must deploy the bridge Worker and corresponding container image yourself

You can use the example bridge directly:

- [Cloudflare sandbox bridge example on GitHub](https://github.com/geminixiang/mikan/tree/main/deploy/examples/cloudflare-sandbox-bridge)
