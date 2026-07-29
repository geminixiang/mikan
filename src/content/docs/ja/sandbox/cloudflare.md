---
title: Cloudflare sandbox
description: 自分でデプロイした Cloudflare Worker bridge を使い、experimental Cloudflare sandbox を実行します。
---

```bash
export CLOUDFLARE_SANDBOX_URL="https://your-bridge.workers.dev"
export CLOUDFLARE_SANDBOX_TOKEN="replace-me" # optional

mikan --sandbox=cloudflare:mikan-remote /path/to/workspace
```

特徴：

- runtime commands は既定で `/workspace` を使用します。`CLOUDFLARE_SANDBOX_CWD` で上書きできます
- mikan は remote sandbox id を `<base-sandbox-id>-<vault-key>` に派生させます
- vault env は各 `exec()` 時に bridge 経由で注入されます
- vault 選択ロジックは `image` と似ており、conversation ID から platform-scoped vault key を生成します

制限：

- リモートの `/workspace` はローカル作業ディレクトリを自動 mirror しません
- そのため `pwd` は `/workspace` を表示しますが、`ls` は空かもしれません。これは想定どおりで、ローカル repo を読んでいるわけではありません
- vault file credential は現時点では Cloudflare sandbox へ自動投影されません
- bridge Worker と対応する container image を自分でデプロイする必要があります

サンプル bridge をそのまま使用できます：

- [GitHub の Cloudflare sandbox bridge サンプル](https://github.com/geminixiang/mikan/tree/main/deploy/examples/cloudflare-sandbox-bridge)
